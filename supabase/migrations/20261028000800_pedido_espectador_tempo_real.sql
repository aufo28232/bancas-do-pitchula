-- =====================================================================
-- Etapa 4 · Pedido do espectador, chat, prazo de resposta e tempo real
-- ARCHITECTURE §5.5, §5.6 · DECISIONS D-003, D-008, D-009, D-043, D-046
--
-- Tempo real: só Broadcast PRIVADO emitido por triggers (o cliente nunca
-- recebe linhas de tabela). Ninguém tem permissão de ENVIAR broadcast.
--   pedido:{id}   -> só o espectador dono (sessão anônima vinculada ao pedido)
--   staff:{banca} -> staff AAL2 com sessão viva (só ids e estados, sem dados pessoais)
--   vagas:{code}  -> qualquer um, SÓ LEITURA (número de vagas e estado)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Sessão do pedido (cookie httpOnly do espectador)
-- ---------------------------------------------------------------------
create function app.order_from_session(p_session_hash bytea)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid;
begin
  update app.order_sessions s
     set last_seen_at = now()
    from app.orders o
   where s.session_hash = p_session_hash
     and s.revoked_at is null
     and s.created_at > now() - interval '30 days'
     and o.id = s.order_id
     and o.token_revoked_at is null
  returning s.order_id into v_order;
  return v_order;
end;
$$;

-- Troca o token do link (só o hash chega aqui) por uma sessão de cookie.
create function api.srv_open_order_session(p_token_hash bytea, p_session_hash bytea)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid;
begin
  select o.id into v_order
    from app.orders o
   where o.access_token_hash = p_token_hash
     and o.token_revoked_at is null;
  if v_order is null then
    return null;
  end if;
  insert into app.order_sessions (order_id, session_hash) values (v_order, p_session_hash);
  return v_order;
end;
$$;

-- Vincula o usuário ANÔNIMO do Supabase (só para o Realtime) ao pedido da sessão.
create function api.srv_bind_viewer(p_session_hash bytea, p_viewer uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid := app.order_from_session(p_session_hash);
begin
  if v_order is null then
    return false;
  end if;
  if not exists (select 1 from auth.users u where u.id = p_viewer and u.is_anonymous) then
    raise exception 'usuário não é anônimo' using errcode = '22023';
  end if;
  update app.orders set viewer_uid = p_viewer where id = v_order;
  return true;
end;
$$;

-- ---------------------------------------------------------------------
-- Prazo de resposta de 5 min (D-043)
-- ---------------------------------------------------------------------
create function app.expire_order_if_due(p_order uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_banca uuid;
begin
  update app.orders
     set status = 'recusado', refused_at = now(), refused_by = null, refusal_reason = 'sem_resposta',
         locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
   where id = p_order
     and status = 'pendente'
     and reply_deadline_at is not null
     and reply_deadline_at < now()
  returning banca_id into v_banca;

  if v_banca is null then
    return false;
  end if;

  update app.banca_stats set refused = refused + 1 where banca_id = v_banca;
  insert into app.order_messages (order_id, author, body)
  values (p_order, 'sistema', 'O tempo para responder acabou e o pedido foi encerrado.');
  perform app.audit('pedido_expirado', null, 'sistema', p_banca_id => v_banca, p_order_id => p_order,
                    p_detail => '{"motivo": "sem_resposta"}'::jsonb);
  return true;
end;
$$;

-- Job (pg_cron a cada 15 s). A checagem preguiçosa nas funções do pedido garante
-- a regra mesmo que o job atrase.
create function app.expire_unanswered()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select id from app.orders
     where status = 'pendente' and reply_deadline_at < now()
     for update skip locked
  loop
    if app.expire_order_if_due(r.id) then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Estado do pedido para o espectador (o servidor decifra e MASCARA os dados, D-023)
-- ---------------------------------------------------------------------
create function api.srv_viewer_state(p_session_hash bytea)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid := app.order_from_session(p_session_hash);
  o       app.orders;
  b       app.bancas;
  v_pos   integer;
  v_ativo boolean;
  v_atend text;
begin
  if v_order is null then
    return null;
  end if;
  perform app.expire_order_if_due(v_order);

  select * into o from app.orders where id = v_order;
  select * into b from app.bancas where id = o.banca_id;

  if o.status = 'pendente' then
    select count(*) + 1 into v_pos from app.orders x
     where x.banca_id = o.banca_id and x.status = 'pendente' and x.seq < o.seq;
  end if;
  v_ativo := o.locked_by is not null and o.lock_activity_at > now() - interval '10 minutes';
  if v_ativo then
    select s.display_name into v_atend from app.staff s where s.user_id = o.locked_by;
  end if;

  return jsonb_build_object(
    'pedido', jsonb_build_object(
      'id', o.id,
      'status', o.status,
      'posicao', v_pos,
      'em_atendimento', v_ativo,
      'atendente', v_atend,
      'motivo', o.refusal_reason,
      'nota', o.refusal_note,
      'prazo', o.reply_deadline_at,
      'criado_em', o.created_at,
      'pix_tipo', o.pix_type,
      'enc', jsonb_build_object(
        'nome', o.full_name_enc, 'cpf', o.cpf_enc, 'pix', o.pix_key_enc, 'pid', o.platform_id_enc)
    ),
    'banca', jsonb_build_object('nome', b.name, 'codigo', b.code, 'status', b.status),
    'mensagens', coalesce((
      select jsonb_agg(m.obj order by m.created_at)
        from (
          select mm.created_at,
                 jsonb_build_object(
                   'id', mm.id, 'autor', mm.author, 'texto', mm.body, 'tem_anexo', mm.attachment_id is not null,
                   'atendente', (select s.display_name from app.staff s where s.user_id = mm.staff_id),
                   'criada_em', mm.created_at) as obj
            from app.order_messages mm
           where mm.order_id = v_order
           order by mm.created_at desc
           limit 200
        ) m
    ), '[]'::jsonb)
  );
end;
$$;

-- Mensagem do espectador. Resultado: 'ok' | 'sessao' | 'finalizado'.
create function api.srv_viewer_post_message(p_session_hash bytea, p_body text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order  uuid := app.order_from_session(p_session_hash);
  v_status app.order_status;
begin
  if v_order is null then
    return 'sessao';
  end if;
  -- Chegou depois do prazo? Expira primeiro e recusa a mensagem.
  perform app.expire_order_if_due(v_order);
  select status into v_status from app.orders where id = v_order for update;
  if v_status <> 'pendente' then
    return 'finalizado';
  end if;

  insert into app.order_messages (order_id, author, body) values (v_order, 'espectador', p_body);
  -- Resposta do espectador para o relógio (D-043).
  update app.orders set reply_deadline_at = null where id = v_order and reply_deadline_at is not null;
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------
-- Broadcast disparado por trigger
-- ---------------------------------------------------------------------
create function app.rt(p_topic text, p_event text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(p_payload, p_event, p_topic, true);
end;
$$;

-- Posição na fila (D-009). Só quem está a partir de `p_desde_seq` muda de posição:
-- um pedido novo entra no fim; quando um pendente sai, só os de trás sobem.
create function app.rt_posicoes(p_banca uuid, p_desde_seq bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select id, seq, row_number() over (order by seq) as pos
      from app.orders
     where banca_id = p_banca and status = 'pendente'
  loop
    if r.seq >= p_desde_seq then
      perform app.rt('pedido:' || r.id, 'posicao', jsonb_build_object('posicao', r.pos));
    end if;
  end loop;
end;
$$;

create function app.rt_orders()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_atendente text;
begin
  if new.locked_by is not null then
    select display_name into v_atendente from app.staff where user_id = new.locked_by;
  end if;

  perform app.rt('pedido:' || new.id, 'status', jsonb_build_object(
    'status', new.status,
    'em_atendimento', new.locked_by is not null,
    'atendente', v_atendente,
    'motivo', new.refusal_reason,
    'prazo', new.reply_deadline_at));

  if tg_op = 'UPDATE' and new.locked_by is not null and new.locked_by is distinct from old.locked_by then
    perform app.rt('pedido:' || new.id, 'assumido', jsonb_build_object('atendente', v_atendente));
  end if;
  if tg_op = 'UPDATE' and new.reply_deadline_at is distinct from old.reply_deadline_at then
    perform app.rt('pedido:' || new.id, 'prazo', jsonb_build_object('expira_em', new.reply_deadline_at));
  end if;

  -- Para o painel: só id e estado, nunca dados pessoais.
  perform app.rt('staff:' || new.banca_id, 'fila', jsonb_build_object(
    'pedido', new.id, 'status', new.status, 'em_atendimento', new.locked_by is not null));

  if tg_op = 'INSERT' then
    perform app.rt_posicoes(new.banca_id, new.seq);
  elsif new.status is distinct from old.status then
    perform app.rt_posicoes(new.banca_id, new.seq + 1);
  end if;
  return new;
end;
$$;

create trigger orders_tempo_real
  after insert or update of status, locked_by, reply_deadline_at on app.orders
  for each row execute function app.rt_orders();

create function app.rt_order_messages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_banca uuid;
begin
  select banca_id into v_banca from app.orders where id = new.order_id;
  perform app.rt('pedido:' || new.order_id, 'mensagem', jsonb_build_object(
    'id', new.id,
    'autor', new.author,
    'texto', new.body,
    'tem_anexo', new.attachment_id is not null,
    'atendente', (select display_name from app.staff where user_id = new.staff_id),
    'criada_em', new.created_at));
  perform app.rt('staff:' || v_banca, 'mensagem', jsonb_build_object('pedido', new.order_id, 'autor', new.author));
  return new;
end;
$$;

create trigger order_messages_tempo_real
  after insert on app.order_messages
  for each row execute function app.rt_order_messages();

create function app.rt_bancas()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.code is not null then
    perform app.rt('vagas:' || new.code, 'vagas', jsonb_build_object(
      'restantes', new.slots - new.paid_count, 'total', new.slots, 'status', new.status));
  end if;
  -- Encerrada: o código some; avisa quem está na página (D-044).
  if new.status = 'encerrada' and old.code is not null then
    perform app.rt('vagas:' || old.code, 'banca_encerrada', '{}'::jsonb);
  end if;
  return new;
end;
$$;

create trigger bancas_tempo_real
  after update of paid_count, slots, status on app.bancas
  for each row execute function app.rt_bancas();

-- ---------------------------------------------------------------------
-- Autorização dos canais (RLS em realtime.messages)
-- ---------------------------------------------------------------------
create function app.viewer_owns_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_topic like 'pedido:%'
     and coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true'
     and exists (
       select 1 from app.orders o
        where o.id = app.try_uuid(substr(p_topic, 8))
          and o.viewer_uid = auth.uid()
          and o.token_revoked_at is null
     )
$$;

create policy rt_pedido_dono on realtime.messages
  for select to authenticated
  using (realtime.messages.extension = 'broadcast' and app.viewer_owns_topic((select realtime.topic())));

create policy rt_staff on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) like 'staff:%'
    and (select app.current_staff_role()) is not null
  );

create policy rt_vagas_leitura on realtime.messages
  for select to anon, authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'vagas:%');

-- Nenhuma política de INSERT: nenhum cliente consegue emitir broadcast (D-008).

-- ---------------------------------------------------------------------
-- Agendamento (pg_cron). Só cria se a extensão existir (Supabase tem).
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    execute $cron$ select cron.schedule('expirar-pedidos-sem-resposta', '15 seconds', 'select app.expire_unanswered()') $cron$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke all on function
  app.order_from_session(bytea), app.expire_order_if_due(uuid), app.expire_unanswered(),
  app.rt(text, text, jsonb), app.rt_posicoes(uuid, bigint), app.rt_orders(), app.rt_order_messages(), app.rt_bancas(),
  app.viewer_owns_topic(text),
  api.srv_open_order_session(bytea, bytea), api.srv_bind_viewer(bytea, uuid),
  api.srv_viewer_state(bytea), api.srv_viewer_post_message(bytea, text)
from public, anon, authenticated, service_role;

grant execute on function app.viewer_owns_topic(text) to authenticated;
grant execute on function
  api.srv_open_order_session(bytea, bytea), api.srv_bind_viewer(bytea, uuid),
  api.srv_viewer_state(bytea), api.srv_viewer_post_message(bytea, text)
to service_role;
