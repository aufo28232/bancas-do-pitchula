-- =====================================================================
-- Etapa 2 · Funções de staff: sessões, convites, equipe, alertas
-- ARCHITECTURE §5.1, §5.2 e §4.
--
-- Convenção de nomes (schema `api`, o único exposto):
--   api.staff_*  -> qualquer staff AAL2 (owner ou moderador), JWT do usuário
--   api.owner_*  -> só o streamer (owner) AAL2, JWT do usuário
--   api.preauth_* -> staff ainda em AAL1 (tela de MFA), JWT do usuário
--   api.srv_*    -> só o servidor (service_role); a função faz as checagens
-- Toda função é SECURITY DEFINER com search_path vazio e confere a
-- identidade NO BANCO, além da checagem que o servidor já faz.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helpers internos (não expostos)
-- ---------------------------------------------------------------------
create function app.require_staff()
returns app.staff_role
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.current_staff_role();
begin
  if v_role is null then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  return v_role;
end;
$$;

create function app.require_owner()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if app.current_staff_role() is distinct from 'owner' then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
end;
$$;

create function app.current_session_id()
returns uuid
language sql
stable
set search_path = ''
as $$ select app.try_uuid(auth.jwt() ->> 'session_id') $$;

-- Revoga sessões: marca na tabela própria E apaga no Supabase Auth
-- (o que invalida os refresh tokens daquela sessão).
create function app.revoke_sessions(p_user uuid, p_session uuid, p_by uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  update app.staff_sessions
     set revoked_at = now(), revoked_by = p_by
   where user_id = p_user
     and (p_session is null or session_id = p_session)
     and revoked_at is null;
  get diagnostics v_n = row_count;

  delete from auth.sessions
   where user_id = p_user
     and (p_session is null or id = p_session);

  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Contexto do staff (toda página/rota do painel chama isto)
-- ---------------------------------------------------------------------
create function api.staff_whoami()
returns table (user_id uuid, role app.staff_role, display_name text, session_id uuid, live_mode boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_sid uuid := app.current_session_id();
begin
  perform app.require_staff();

  -- Marca atividade (no máximo 1 vez por minuto): base da expiração por inatividade de 8h.
  update app.staff_sessions
     set last_seen_at = now()
   where session_id = v_sid
     and last_seen_at < now() - interval '1 minute';

  return query
    select s.user_id, s.role, s.display_name, ss.session_id, ss.live_mode
      from app.staff s
      join app.staff_sessions ss on ss.user_id = s.user_id
     where s.user_id = auth.uid()
       and ss.session_id = v_sid;
end;
$$;

-- Tela de MFA: o usuário ainda está em AAL1. Exige staff ativo e sessão viva,
-- mas NÃO exige AAL2. Não dá acesso a nenhum dado além do próprio apelido.
create function api.preauth_whoami()
returns table (user_id uuid, role app.staff_role, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_claims jsonb := auth.jwt();
  v_sid    uuid := app.current_session_id();
begin
  if auth.uid() is null or v_sid is null
     or coalesce(v_claims ->> 'is_anonymous', 'false') <> 'false' then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  return query
    select s.user_id, s.role, s.display_name
      from app.staff s
      join app.staff_sessions ss on ss.user_id = s.user_id and ss.session_id = v_sid
      join auth.sessions a on a.id = ss.session_id and a.user_id = s.user_id
     where s.user_id = auth.uid()
       and s.active
       and ss.revoked_at is null
       and ss.last_seen_at > now() - interval '8 hours';

  if not found then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Login (servidor)
-- ---------------------------------------------------------------------
-- Registra a sessão recém-criada pelo Supabase Auth. Retorna NULL se o
-- usuário não for staff ativo (o servidor então encerra a sessão no Auth).
create function api.srv_register_staff_session(
  p_user        uuid,
  p_session     uuid,
  p_device_hash bytea,
  p_ua_summary  text,
  p_location    text
)
returns table (novo_dispositivo boolean, role app.staff_role)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role     app.staff_role;
  v_device   uuid;
  v_novo     boolean := false;
  v_outros   integer;
begin
  select s.role into v_role from app.staff s where s.user_id = p_user and s.active;
  if v_role is null then
    perform app.audit('login_negado', null, 'sistema', p_detail => '{"motivo": "nao_e_staff_ativo"}'::jsonb);
    return;
  end if;

  if not exists (select 1 from auth.sessions a where a.id = p_session and a.user_id = p_user) then
    raise exception 'sessão inexistente' using errcode = '22023';
  end if;

  select count(*) into v_outros from app.known_devices d where d.user_id = p_user;

  select d.id into v_device from app.known_devices d where d.user_id = p_user and d.device_hash = p_device_hash;
  if v_device is null then
    insert into app.known_devices (user_id, device_hash) values (p_user, p_device_hash) returning id into v_device;
    v_novo := true;
  else
    update app.known_devices set last_seen_at = now() where id = v_device;
  end if;

  insert into app.staff_sessions (session_id, user_id, device_id, ua_summary, approx_location)
  values (p_session, p_user, v_device, left(p_ua_summary, 80), left(p_location, 80))
  on conflict (session_id) do nothing;

  -- Alerta só quando já havia outro dispositivo conhecido (o primeiro acesso não é "novo") (D-053).
  if v_novo and v_outros > 0 then
    insert into app.security_alerts (user_id, session_id, kind) values (p_user, p_session, 'novo_dispositivo');
  end if;

  perform app.audit('login', p_user, v_role::text,
                    p_detail => jsonb_build_object('dispositivo_novo', v_novo, 'sessao', p_session::text));

  return query select v_novo, v_role;
end;
$$;

create function api.srv_login_failed()
returns void
language sql
security definer
set search_path = ''
as $$ select app.audit('login_falhou', null, 'sistema') is not null $$;

-- Encerra a PRÓPRIA sessão (logout). Funciona também em AAL1 (tela de MFA).
-- O id da sessão vem do JWT verificado pelo PostgREST, nunca de um parâmetro:
-- assim ninguém consegue encerrar a sessão de outra pessoa.
create function api.preauth_end_session()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sid  uuid := app.current_session_id();
  v_role text;
begin
  if auth.uid() is null or v_sid is null then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  select s.role::text into v_role
    from app.staff s
    join app.staff_sessions ss on ss.user_id = s.user_id and ss.session_id = v_sid
   where s.user_id = auth.uid() and ss.revoked_at is null;
  if v_role is null then
    return;
  end if;
  perform app.revoke_sessions(auth.uid(), v_sid, auth.uid());
  perform app.audit('logout', auth.uid(), v_role, p_detail => jsonb_build_object('sessao', v_sid::text));
end;
$$;

-- ---------------------------------------------------------------------
-- Sessões e alertas
-- ---------------------------------------------------------------------
create function api.staff_list_sessions()
returns table (
  session_id uuid, user_id uuid, display_name text, created_at timestamptz, last_seen_at timestamptz,
  ua_summary text, approx_location text, revoked_at timestamptz, atual boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role app.staff_role := app.require_staff();
begin
  return query
    select ss.session_id, ss.user_id, s.display_name, ss.created_at, ss.last_seen_at,
           ss.ua_summary, ss.approx_location, ss.revoked_at, ss.session_id = app.current_session_id()
      from app.staff_sessions ss
      join app.staff s on s.user_id = ss.user_id
     where (v_role = 'owner' or ss.user_id = auth.uid())
       and ss.revoked_at is null
       and ss.last_seen_at > now() - interval '8 hours'
     order by ss.last_seen_at desc;
end;
$$;

create function api.staff_revoke_session(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  v_dono uuid;
begin
  select ss.user_id into v_dono from app.staff_sessions ss where ss.session_id = p_session and ss.revoked_at is null;
  if v_dono is null then
    raise exception 'sessão não encontrada' using errcode = 'P0002';
  end if;
  if v_role <> 'owner' and v_dono <> auth.uid() then
    raise exception 'acesso negado' using errcode = '42501';
  end if;

  perform app.revoke_sessions(v_dono, p_session, auth.uid());
  perform app.audit('sessao_revogada', auth.uid(), v_role::text, p_target => v_dono,
                    p_detail => jsonb_build_object('sessao', p_session::text));
end;
$$;

create function api.owner_list_alerts()
returns table (id uuid, user_id uuid, display_name text, kind text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.require_owner();
  return query
    select a.id, a.user_id, s.display_name, a.kind, a.created_at
      from app.security_alerts a
      join app.staff s on s.user_id = a.user_id
     where a.acknowledged_at is null
     order by a.created_at desc;
end;
$$;

create function api.owner_ack_alert(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_owner();
  update app.security_alerts
     set acknowledged_at = now(), acknowledged_by = auth.uid()
   where id = p_id and acknowledged_at is null;
  if not found then
    raise exception 'alerta não encontrado' using errcode = 'P0002';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Equipe
-- ---------------------------------------------------------------------
create function api.owner_list_staff()
returns table (user_id uuid, role app.staff_role, display_name text, active boolean, created_at timestamptz, sessoes_ativas integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.require_owner();
  return query
    select s.user_id, s.role, s.display_name, s.active, s.created_at,
           (select count(*)::int from app.staff_sessions ss
             where ss.user_id = s.user_id and ss.revoked_at is null and ss.last_seen_at > now() - interval '8 hours')
      from app.staff s
     order by s.active desc, s.role, s.display_name;
end;
$$;

-- Remover moderador: desativa, derruba todas as sessões e solta os atendimentos travados.
create function api.owner_deactivate_staff(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_owner();
  update app.staff
     set active = false, deactivated_at = now()
   where user_id = p_user and role = 'moderator' and active;
  if not found then
    raise exception 'moderador não encontrado' using errcode = 'P0002';
  end if;

  perform app.revoke_sessions(p_user, null, auth.uid());

  update app.orders
     set locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
   where locked_by = p_user and status = 'pendente';

  perform app.audit('moderador_remover', auth.uid(), 'owner', p_target => p_user);
end;
$$;

-- Reset de MFA de um moderador: autoriza, derruba as sessões e audita.
-- Em seguida o SERVIDOR apaga os fatores pela API admin do Supabase Auth.
create function api.owner_prepare_mfa_reset(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_owner();
  if p_user = auth.uid() then
    -- O MFA do streamer é recuperado manualmente pelo dashboard (SECURITY.md).
    raise exception 'o streamer não reseta o próprio MFA pelo painel' using errcode = '22023';
  end if;
  if not exists (select 1 from app.staff s where s.user_id = p_user and s.role = 'moderator' and s.active) then
    raise exception 'moderador não encontrado' using errcode = 'P0002';
  end if;

  perform app.revoke_sessions(p_user, null, auth.uid());
  perform app.audit('mfa_reset', auth.uid(), 'owner', p_target => p_user);
end;
$$;

-- ---------------------------------------------------------------------
-- Convites
-- ---------------------------------------------------------------------
create function api.owner_create_invite(p_token_hash bytea, p_display_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.require_owner();
  insert into app.staff_invites (token_hash, display_name, created_by, expires_at)
  values (p_token_hash, btrim(p_display_name), auth.uid(), now() + interval '24 hours')
  returning id into v_id;
  perform app.audit('convite_criar', auth.uid(), 'owner');
  return v_id;
end;
$$;

create function api.owner_revoke_invite(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_owner();
  update app.staff_invites
     set revoked_at = now()
   where id = p_id and used_at is null and revoked_at is null;
  if not found then
    raise exception 'convite não encontrado ou já usado' using errcode = 'P0002';
  end if;
  perform app.audit('convite_revogar', auth.uid(), 'owner');
end;
$$;

create function api.owner_list_invites()
returns table (id uuid, display_name text, created_at timestamptz, expires_at timestamptz, situacao text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.require_owner();
  return query
    select i.id, i.display_name, i.created_at, i.expires_at,
           case
             when i.used_at is not null then 'usado'
             when i.revoked_at is not null then 'revogado'
             when i.expires_at <= now() then 'expirado'
             else 'pendente'
           end
      from app.staff_invites i
     where i.created_at > now() - interval '30 days'
     order by i.created_at desc;
end;
$$;

-- Confere (sem consumir) se o convite é válido. Servidor, antes de criar a conta.
create function api.srv_check_invite(p_token_hash bytea)
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.display_name
    from app.staff_invites i
   where i.token_hash = p_token_hash
     and i.used_at is null
     and i.revoked_at is null
     and i.expires_at > now()
$$;

-- Consome o convite de forma ATÔMICA e cria o moderador. Retorna false se
-- o convite já foi usado, revogado ou expirou (o servidor apaga a conta criada).
create function api.srv_consume_invite(p_token_hash bytea, p_user uuid, p_display_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv app.staff_invites;
begin
  update app.staff_invites
     set used_at = now(), used_by = p_user
   where token_hash = p_token_hash
     and used_at is null
     and revoked_at is null
     and expires_at > now()
  returning * into v_inv;

  if v_inv.id is null then
    return false;
  end if;

  insert into app.staff (user_id, role, display_name, created_by)
  values (p_user, 'moderator', btrim(p_display_name), v_inv.created_by);

  perform app.audit('convite_aceito', p_user, 'moderator', p_target => v_inv.created_by);
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Seed do streamer (script de seed, uma única vez)
-- ---------------------------------------------------------------------
create function api.srv_seed_owner(p_user uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from app.staff where role = 'owner' and active) then
    raise exception 'já existe um streamer ativo' using errcode = '23505';
  end if;
  insert into app.staff (user_id, role, display_name) values (p_user, 'owner', btrim(p_display_name));
  perform app.audit('owner_criado', null, 'sistema', p_target => p_user);
end;
$$;

-- ---------------------------------------------------------------------
-- Privilégios: nada por padrão; cada função é liberada explicitamente.
-- ---------------------------------------------------------------------
revoke all on all functions in schema app from public, anon, authenticated, service_role;
revoke all on all functions in schema api from public, anon, authenticated, service_role;

grant execute on function app.current_staff_role() to authenticated;

grant execute on function
  api.staff_whoami(),
  api.preauth_whoami(),
  api.preauth_end_session(),
  api.staff_list_sessions(),
  api.staff_revoke_session(uuid),
  api.owner_list_alerts(),
  api.owner_ack_alert(uuid),
  api.owner_list_staff(),
  api.owner_deactivate_staff(uuid),
  api.owner_prepare_mfa_reset(uuid),
  api.owner_create_invite(bytea, text),
  api.owner_revoke_invite(uuid),
  api.owner_list_invites()
to authenticated;

grant execute on function
  api.srv_register_staff_session(uuid, uuid, bytea, text, text),
  api.srv_login_failed(),
  api.srv_check_invite(bytea),
  api.srv_consume_invite(bytea, uuid, text),
  api.srv_seed_owner(uuid, text)
to service_role;
