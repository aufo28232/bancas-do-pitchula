-- =====================================================================
-- Etapa 1 · Identidade do staff, RLS e privilégios (ARCHITECTURE §4)
--
-- Modelo:
--   * O navegador nunca acessa tabelas (D-002). `app` não é exposto no PostgREST.
--   * `authenticated` recebe APENAS SELECT, e só nas tabelas que o staff lê;
--     cada linha passa pela RLS, que exige staff ativo + AAL2 + sessão viva.
--   * Escritas acontecem só em funções SECURITY DEFINER (etapas seguintes),
--     que repetem as checagens.
--   * RLS ligado (ENABLE) em todas as tabelas. Não usamos FORCE porque as
--     funções SECURITY DEFINER pertencem ao dono das tabelas e precisam
--     escrever nelas; o dono nunca é um papel usado pela aplicação.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Papel do staff na requisição atual, ou NULL.
-- Verdadeiro só se TODAS as condições valerem (ARCHITECTURE §4.2):
--   não anônimo; aal2; staff ativo; sessão existe em auth.sessions;
--   sessão não revogada na tabela própria; atividade nas últimas 8h.
-- ---------------------------------------------------------------------
create function app.current_staff_role()
returns app.staff_role
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims  jsonb := auth.jwt();
  v_uid     uuid := auth.uid();
  v_session uuid;
  v_role    app.staff_role;
begin
  if v_uid is null or v_claims is null then
    return null;
  end if;
  if coalesce(v_claims ->> 'is_anonymous', 'false') <> 'false' then
    return null;
  end if;
  if coalesce(v_claims ->> 'aal', '') <> 'aal2' then
    return null;
  end if;

  v_session := app.try_uuid(v_claims ->> 'session_id');
  if v_session is null then
    return null;
  end if;

  select s.role into v_role
  from app.staff s
  join app.staff_sessions ss on ss.user_id = s.user_id and ss.session_id = v_session
  join auth.sessions a on a.id = ss.session_id and a.user_id = s.user_id
  where s.user_id = v_uid
    and s.active
    and ss.revoked_at is null
    and ss.last_seen_at > now() - interval '8 hours'
    and (a.not_after is null or a.not_after > now());

  return v_role;
end;
$$;

-- ---------------------------------------------------------------------
-- RLS em todas as tabelas
-- ---------------------------------------------------------------------
alter table app.staff               enable row level security;
alter table app.staff_invites       enable row level security;
alter table app.known_devices       enable row level security;
alter table app.staff_sessions      enable row level security;
alter table app.security_alerts     enable row level security;
alter table app.bancas              enable row level security;
alter table app.banca_stats         enable row level security;
alter table app.orders              enable row level security;
alter table app.order_sessions      enable row level security;
alter table app.order_attachments   enable row level security;
alter table app.order_messages      enable row level security;
alter table app.storage_purge_queue enable row level security;
alter table app.bans                enable row level security;
alter table app.quick_replies       enable row level security;
alter table app.idempotency_keys    enable row level security;
alter table app.audit_log           enable row level security;
alter table app.audit_anchor        enable row level security;

-- Staff AAL2 (owner ou moderador) ---------------------------------------
create policy staff_le on app.staff
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

create policy staff_le on app.bancas
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

create policy staff_le on app.banca_stats
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

create policy staff_le on app.orders
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

create policy staff_le on app.order_messages
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

create policy staff_le on app.order_attachments
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

create policy staff_le on app.bans
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

create policy staff_le on app.quick_replies
  for select to authenticated
  using ((select app.current_staff_role()) is not null);

-- Próprias linhas (moderador) ou todas (owner) --------------------------
create policy proprio_ou_owner on app.staff_sessions
  for select to authenticated
  using (
    (select app.current_staff_role()) = 'owner'
    or (user_id = (select auth.uid()) and (select app.current_staff_role()) is not null)
  );

create policy proprio_ou_owner on app.known_devices
  for select to authenticated
  using (
    (select app.current_staff_role()) = 'owner'
    or (user_id = (select auth.uid()) and (select app.current_staff_role()) is not null)
  );

create policy proprio_ou_owner on app.security_alerts
  for select to authenticated
  using (
    (select app.current_staff_role()) = 'owner'
    or (user_id = (select auth.uid()) and (select app.current_staff_role()) is not null)
  );

-- Só owner ----------------------------------------------------------------
create policy owner_le on app.staff_invites
  for select to authenticated
  using ((select app.current_staff_role()) = 'owner');

create policy owner_le on app.audit_log
  for select to authenticated
  using ((select app.current_staff_role()) = 'owner');

create policy owner_le on app.audit_anchor
  for select to authenticated
  using ((select app.current_staff_role()) = 'owner');

-- order_sessions, storage_purge_queue, idempotency_keys: sem política =
-- ninguém lê nem escreve fora das funções do banco.

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke all on all tables in schema app from public, anon, authenticated, service_role;
revoke all on all sequences in schema app from public, anon, authenticated, service_role;
revoke all on all functions in schema app from public, anon, authenticated, service_role;
revoke all on all functions in schema api from public, anon, authenticated, service_role;

grant select on
  app.staff,
  app.known_devices,
  app.staff_sessions,
  app.security_alerts,
  app.bancas,
  app.banca_stats,
  app.order_messages,
  app.order_attachments,
  app.bans,
  app.quick_replies,
  app.audit_log,
  app.audit_anchor
to authenticated;

-- Pedidos: todas as colunas, MENOS o hash do token de acesso.
grant select (
  id, banca_id, seq, status, full_name_enc, cpf_enc, pix_type, pix_key_enc, platform_id_enc,
  cpf_hmac, pix_hmac, platform_id_hmac, ip_hmac, hmac_key_version, ip_unique,
  token_revoked_at, viewer_uid, locked_by, locked_at, lock_activity_at, reply_deadline_at,
  paid_by, paid_at, refused_by, refused_at, refusal_reason, refusal_note, has_receipt,
  created_at, updated_at
) on app.orders to authenticated;

-- Convites: todas as colunas, MENOS o hash do token.
grant select (
  id, display_name, created_by, created_at, expires_at, used_at, used_by, revoked_at
) on app.staff_invites to authenticated;

-- As políticas acima chamam esta função com o papel de quem consulta.
grant execute on function app.current_staff_role() to authenticated;
