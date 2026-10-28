-- =====================================================================
-- Etapa 6 · Comprovantes, encerramento com exclusão imediata, retenção
-- ARCHITECTURE §5.7, §5.10, §5.11 · DECISIONS D-005, D-018, D-020, D-021,
-- D-044, D-045, D-075
--
-- Os ARQUIVOS (Storage) e as contas anônimas (Auth) não podem ser apagados por
-- SQL de forma suportada: o banco põe numa fila e o servidor da aplicação apaga
-- pelas APIs do Supabase (POST /api/interno/limpeza, D-075).
-- =====================================================================

-- Pedido com dados pessoais apagados a pedido do titular (D-018).
alter table app.orders add column data_erased_at timestamptz;

-- Fila de contas anônimas do Supabase Auth a apagar.
create table app.auth_purge_queue (
  user_id     uuid primary key,
  enqueued_at timestamptz not null default now(),
  attempts    integer not null default 0 check (attempts >= 0),
  last_error  text,
  done_at     timestamptz,
  constraint auth_purge_erro_ck check (last_error is null or char_length(last_error) <= 200)
);
create index auth_purge_pendentes_idx on app.auth_purge_queue (enqueued_at) where done_at is null;
alter table app.auth_purge_queue enable row level security;
revoke all on app.auth_purge_queue from public, anon, authenticated, service_role;

-- Bucket privado dos comprovantes (5 MB, só WEBP: o servidor sempre re-encoda).
-- No Supabase local ele também está no config.toml; em produção, esta linha cria.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('comprovantes', 'comprovantes', false, 5242880, array['image/webp'])
    on conflict (id) do update
      set public = false, file_size_limit = 5242880, allowed_mime_types = array['image/webp'];
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Apoio
-- ---------------------------------------------------------------------
-- Texto que passa no formato de cifra mas não decifra com nenhuma chave (v0 não existe).
create function app.tombstone()
returns text
language sql
volatile
set search_path = ''
as $$
  select 'v0:' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
$$;

create function app.enqueue_viewer_purge(p_user uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into app.auth_purge_queue (user_id)
  select p_user where p_user is not null
  on conflict (user_id) do update set done_at = null, attempts = 0, last_error = null
$$;

-- Apaga os dados pessoais de um pedido e mantém só o mínimo para os agregados e
-- para impedir um novo pedido com o mesmo CPF/IP na mesma banca (D-018).
create function app.erase_order_personal(p_order uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_viewer uuid;
begin
  select viewer_uid into v_viewer from app.orders where id = p_order for update;
  delete from app.order_messages where order_id = p_order;
  delete from app.order_attachments where order_id = p_order;  -- o trigger enfileira os arquivos
  delete from app.order_sessions where order_id = p_order;
  update app.orders
     set full_name_enc = app.tombstone(), cpf_enc = app.tombstone(),
         pix_key_enc = app.tombstone(), platform_id_enc = app.tombstone(),
         pix_hmac = sha256(convert_to(gen_random_uuid()::text, 'UTF8')),
         platform_id_hmac = sha256(convert_to(gen_random_uuid()::text, 'UTF8')),
         refusal_note = null, has_receipt = false,
         token_revoked_at = coalesce(token_revoked_at, now()),
         viewer_uid = null, data_erased_at = now()
   where id = p_order;
  perform app.enqueue_viewer_purge(v_viewer);
end;
$$;

-- ---------------------------------------------------------------------
-- Comprovantes (o servidor já validou, re-encodou em WEBP e subiu o arquivo)
-- Resultado: 'ok' | 'sessao' | 'finalizado' | 'limite'
-- ---------------------------------------------------------------------
create function api.srv_viewer_add_attachment(
  p_session_hash bytea,
  p_id           uuid,
  p_path         text,
  p_bytes        integer,
  p_width        integer,
  p_height       integer,
  p_sha256       bytea
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid := app.order_from_session(p_session_hash);
  o       app.orders;
begin
  if v_order is null then
    return 'sessao';
  end if;
  perform app.expire_order_if_due(v_order);
  select * into o from app.orders where id = v_order for update;
  if o.status <> 'pendente' then
    return 'finalizado';
  end if;
  -- Máximo de 5 comprovantes por pedido (D-021).
  if (select count(*) from app.order_attachments where order_id = v_order) >= 5 then
    return 'limite';
  end if;
  if p_path <> 'comprovantes/' || o.banca_id || '/' || o.id || '/' || p_id || '.webp' then
    raise exception 'caminho inválido' using errcode = '22023';
  end if;

  insert into app.order_attachments (id, order_id, storage_path, bytes, width, height, sha256)
  values (p_id, v_order, p_path, p_bytes, p_width, p_height, p_sha256);
  insert into app.order_messages (order_id, author, attachment_id) values (v_order, 'espectador', p_id);
  -- Comprovante também é resposta: para o relógio de 5 min (D-043).
  update app.orders set has_receipt = true, reply_deadline_at = null where id = v_order;
  return 'ok';
end;
$$;

-- Caminho do arquivo para o servidor gerar a URL assinada (60 s) ao DONO do pedido.
create function api.srv_viewer_attachment_path(p_session_hash bytea, p_attachment uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select a.storage_path
    from app.order_attachments a
   where a.id = p_attachment
     and a.order_id = app.order_from_session(p_session_hash)
$$;

-- Staff abre o comprovante: auditado e conta como atividade da trava (D-016).
create function api.staff_attachment_path(p_attachment uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  a      app.order_attachments;
  o      app.orders;
begin
  select * into a from app.order_attachments where id = p_attachment;
  if not found then
    raise exception 'comprovante não encontrado' using errcode = 'P0002';
  end if;
  select * into o from app.orders where id = a.order_id;
  if app.lock_active(o) and o.locked_by = auth.uid() then
    update app.orders set lock_activity_at = now() where id = o.id;
  end if;
  perform app.audit('abrir_comprovante', auth.uid(), v_role::text, p_banca_id => o.banca_id, p_order_id => o.id);
  return a.storage_path;
end;
$$;

-- ---------------------------------------------------------------------
-- Exclusão a pedido do titular (D-018). Resultado: 'ok' | 'sessao'
-- ---------------------------------------------------------------------
create function api.srv_viewer_delete(p_session_hash bytea)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid := app.order_from_session(p_session_hash);
  o       app.orders;
begin
  if v_order is null then
    return 'sessao';
  end if;
  select banca_id into o.banca_id from app.orders where id = v_order;
  perform 1 from app.bancas where id = o.banca_id for update;
  select * into o from app.orders where id = v_order for update;

  if o.status = 'pendente' then
    update app.orders
       set status = 'recusado', refused_at = now(), refused_by = null, refusal_reason = 'exclusao_a_pedido',
           locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
     where id = v_order;
    update app.banca_stats set refused = refused + 1 where banca_id = o.banca_id;
  end if;
  perform app.erase_order_personal(v_order);
  perform app.audit('exclusao_dados', null, 'sistema', p_banca_id => o.banca_id, p_order_id => v_order,
                    p_detail => jsonb_build_object('de', o.status::text));
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------
-- Encerrar banca = apagar tudo na hora (D-044, D-045)
-- ---------------------------------------------------------------------
create function app.end_banca(p_banca uuid, p_actor uuid, p_role text, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b       app.bancas;
  s       app.banca_stats;
  r       record;
  v_n     integer;
  v_res   jsonb;
begin
  select * into b from app.bancas where id = p_banca for update;
  if not found or b.status = 'encerrada' then
    raise exception 'banca não encontrada' using errcode = 'P0002';
  end if;
  select * into s from app.banca_stats where banca_id = p_banca;

  -- Avisa quem está conectado ANTES de apagar (o navegador vai para "Aguardando banca...").
  perform app.rt('staff:' || p_banca, 'banca_encerrada', '{}'::jsonb);
  for r in select id, viewer_uid from app.orders where banca_id = p_banca loop
    perform app.rt('pedido:' || r.id, 'banca_encerrada', '{}'::jsonb);
    perform app.enqueue_viewer_purge(r.viewer_uid);
  end loop;

  -- Cascata: mensagens, anexos (o trigger enfileira os arquivos) e sessões.
  delete from app.orders where banca_id = p_banca;
  get diagnostics v_n = row_count;

  -- O código some (o link deixa de existir) e o trigger avisa a página da banca.
  update app.bancas
     set status = 'encerrada', ended_at = now(), ended_by = p_actor, code = null, version = version + 1
   where id = p_banca;

  v_res := jsonb_build_object(
    'recebidos', coalesce(s.received, 0), 'pagos', coalesce(s.paid, 0), 'recusados', coalesce(s.refused, 0),
    'total_pago_cents', coalesce(s.total_paid_cents, 0), 'sobra_cents', b.remainder_cents,
    'quantidade', v_n, 'automatico', p_actor is null, 'motivo', p_motivo);
  perform app.audit('banca_encerrar', p_actor, p_role, p_banca_id => p_banca, p_detail => v_res);
  return v_res;
end;
$$;

create function api.staff_end_banca(p_banca uuid, p_confirm_name text, p_idem uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  v_prev jsonb := app.idem_get(auth.uid(), p_idem, 'banca_encerrar', p_banca);
  v_nome text;
  v_res  jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  select name into v_nome from app.bancas where id = p_banca and status <> 'encerrada';
  if v_nome is null then
    raise exception 'banca não encontrada' using errcode = 'P0002';
  end if;
  -- Confirmação digitando o nome da banca (sem diferenciar maiúsculas e espaços nas pontas).
  if lower(btrim(coalesce(p_confirm_name, ''))) <> lower(btrim(v_nome)) then
    raise exception 'nome de confirmação não confere' using errcode = 'BP005';
  end if;
  v_res := app.end_banca(p_banca, auth.uid(), v_role::text, 'manual');
  perform app.idem_put(auth.uid(), p_idem, 'banca_encerrar', p_banca, v_res);
  return v_res;
end;
$$;

-- Encerramento automático (D-005): fechada há 7 dias, esgotada há 24h,
-- aberta sem pedido novo nem atendimento há 7 dias.
create function app.auto_end_bancas()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r   record;
  v_n integer := 0;
begin
  for r in
    select id,
           case when status = 'fechada' then 'fechada_7d'
                when status = 'esgotada' then 'esgotada_24h'
                else 'parada_7d' end as motivo
      from app.bancas
     where (status = 'fechada' and closed_at < now() - interval '7 days')
        or (status = 'esgotada' and sold_out_at < now() - interval '24 hours')
        or (status = 'aberta' and last_activity_at < now() - interval '7 days')
     for update skip locked
  loop
    perform app.end_banca(r.id, null, 'sistema', r.motivo);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- Retenção (a cada hora). Devolve o que fez, para log.
-- ---------------------------------------------------------------------
create function app.retencao()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sobras  integer;
  v_bans    integer;
  v_idem    integer;
  v_sessoes integer;
  v_anon    integer;
  v_audit   integer;
  v_owner   uuid;
begin
  -- 1. Pedido de banca encerrada não deveria existir; se existir, apaga e alerta.
  with sobras as (
    select o.id, o.viewer_uid from app.orders o join app.bancas b on b.id = o.banca_id where b.status = 'encerrada'
  ), fila as (
    insert into app.auth_purge_queue (user_id) select viewer_uid from sobras where viewer_uid is not null
    on conflict (user_id) do nothing
    returning 1
  )
  delete from app.orders o using sobras s where o.id = s.id;
  get diagnostics v_sobras = row_count;
  if v_sobras > 0 then
    select user_id into v_owner from app.staff where role = 'owner' and active;
    if v_owner is not null then
      insert into app.security_alerts (user_id, kind) values (v_owner, 'retencao_falhou');
    end if;
  end if;

  -- 2. Bans: IP vencido; levantado há 30 dias; revisão anual vencida há 30 dias (D-020).
  delete from app.bans
   where (kind = 'ip' and expires_at < now())
      or (lifted_at is not null and lifted_at < now() - interval '30 days')
      or (lifted_at is null and kind <> 'ip' and review_due_at < now() - interval '30 days');
  get diagnostics v_bans = row_count;

  -- 3. Chaves de idempotência (24h) e sessões de pedido revogadas ou vencidas (30 dias).
  delete from app.idempotency_keys where created_at < now() - interval '24 hours';
  get diagnostics v_idem = row_count;
  delete from app.order_sessions where revoked_at is not null or created_at < now() - interval '30 days';
  get diagnostics v_sessoes = row_count;

  -- 4. Contas anônimas sem pedido há mais de 1 dia vão para a fila de exclusão.
  insert into app.auth_purge_queue (user_id)
  select u.id from auth.users u
   where u.is_anonymous
     and u.created_at < now() - interval '1 day'
     and not exists (select 1 from app.orders o where o.viewer_uid = u.id)
  on conflict (user_id) do nothing;
  get diagnostics v_anon = row_count;

  -- 5. Filas já processadas (7 dias) e auditoria com mais de 12 meses.
  delete from app.storage_purge_queue where done_at < now() - interval '7 days';
  delete from app.auth_purge_queue where done_at < now() - interval '7 days';
  v_audit := app.purge_audit_log();

  return jsonb_build_object('pedidos_sobrando', v_sobras, 'bans', v_bans, 'idempotencia', v_idem,
                            'sessoes', v_sessoes, 'anonimos', v_anon, 'auditoria', v_audit);
end;
$$;

-- ---------------------------------------------------------------------
-- Trabalhador de limpeza (servidor da aplicação, com a service role)
-- ---------------------------------------------------------------------
-- Manutenção completa: serve para quem hospeda sem pg_cron (cron externo, D-075).
create function api.srv_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enc integer := app.auto_end_bancas();
  v_exp integer := app.expire_unanswered();
begin
  return app.retencao() || jsonb_build_object('bancas_encerradas', v_enc, 'pedidos_expirados', v_exp);
end;
$$;

create function api.srv_purge_batch(p_limit integer)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'arquivos', coalesce((
      select jsonb_agg(jsonb_build_object('id', q.id, 'caminho', q.storage_path) order by q.id)
        from (select id, storage_path from app.storage_purge_queue
               where done_at is null and attempts < 5 order by enqueued_at limit greatest(1, least(p_limit, 500))) q
    ), '[]'::jsonb),
    'usuarios', coalesce((
      select jsonb_agg(q.user_id)
        from (select user_id from app.auth_purge_queue
               where done_at is null and attempts < 5 order by enqueued_at limit greatest(1, least(p_limit, 500))) q
    ), '[]'::jsonb)
  )
$$;

create function api.srv_purge_done(
  p_arquivos_ok  bigint[],
  p_arquivos_erro bigint[],
  p_usuarios_ok  uuid[],
  p_usuarios_erro uuid[],
  p_erro         text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_erro text := left(coalesce(p_erro, 'erro'), 200);
begin
  update app.storage_purge_queue set done_at = now() where id = any(coalesce(p_arquivos_ok, '{}'));
  update app.storage_purge_queue set attempts = attempts + 1, last_error = v_erro
   where id = any(coalesce(p_arquivos_erro, '{}'));
  update app.auth_purge_queue set done_at = now() where user_id = any(coalesce(p_usuarios_ok, '{}'));
  update app.auth_purge_queue set attempts = attempts + 1, last_error = v_erro
   where user_id = any(coalesce(p_usuarios_erro, '{}'));
end;
$$;

-- ---------------------------------------------------------------------
-- Leituras que agora devolvem o id do anexo (e "apagado" no painel)
-- ---------------------------------------------------------------------
create or replace function api.srv_viewer_state(p_session_hash bytea)
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
    'banca', jsonb_build_object('id', b.id, 'nome', b.name, 'codigo', b.code, 'status', b.status),
    'mensagens', coalesce((
      select jsonb_agg(m.obj order by m.created_at)
        from (
          select mm.created_at,
                 jsonb_build_object(
                   'id', mm.id, 'autor', mm.author, 'texto', mm.body, 'tem_anexo', mm.attachment_id is not null,
                   'anexo', mm.attachment_id,
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

create or replace function api.staff_get_order(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o app.orders;
  b app.bancas;
begin
  perform app.require_staff();
  perform app.expire_order_if_due(p_order);
  select * into o from app.orders where id = p_order;
  if not found then
    raise exception 'pedido não encontrado' using errcode = 'P0002';
  end if;
  select * into b from app.bancas where id = o.banca_id;

  return jsonb_build_object(
    'pedido', jsonb_build_object(
      'id', o.id, 'seq', o.seq, 'status', o.status, 'criado_em', o.created_at,
      'atendente', case when app.lock_active(o) then app.staff_name(o.locked_by) end,
      'meu', app.lock_active(o) and o.locked_by = auth.uid(),
      'prazo', o.reply_deadline_at, 'motivo', o.refusal_reason, 'nota', o.refusal_note,
      'tem_comprovante', o.has_receipt, 'pix_tipo', o.pix_type, 'apagado', o.data_erased_at is not null,
      'pago_por', app.staff_name(o.paid_by), 'pago_em', o.paid_at,
      'recusado_por', app.staff_name(o.refused_by), 'recusado_em', o.refused_at,
      'enc', jsonb_build_object('nome', o.full_name_enc, 'cpf', o.cpf_enc, 'pix', o.pix_key_enc, 'pid', o.platform_id_enc)
    ),
    'banca', jsonb_build_object(
      'id', b.id, 'nome', b.name, 'status', b.status, 'por_pessoa_cents', b.per_person_cents,
      'restantes', b.slots - b.paid_count),
    'mensagens', coalesce((
      select jsonb_agg(m.obj order by m.created_at)
        from (
          select mm.created_at,
                 jsonb_build_object('id', mm.id, 'autor', mm.author, 'texto', mm.body,
                                    'tem_anexo', mm.attachment_id is not null, 'anexo', mm.attachment_id,
                                    'atendente', app.staff_name(mm.staff_id), 'criada_em', mm.created_at) as obj
            from app.order_messages mm
           where mm.order_id = p_order
           order by mm.created_at desc
           limit 300
        ) m
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function app.rt_order_messages()
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
    'anexo', new.attachment_id,
    'atendente', (select display_name from app.staff where user_id = new.staff_id),
    'criada_em', new.created_at));
  perform app.rt('staff:' || v_banca, 'mensagem', jsonb_build_object('pedido', new.order_id, 'autor', new.author));
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Agendamentos (pg_cron) e chamada ao trabalhador de limpeza (pg_net + Vault)
-- ---------------------------------------------------------------------
-- O servidor da aplicação apaga arquivos e contas anônimas. Em produção, guarde
-- no Vault do Supabase: 'limpeza_url' (https://seu-site/api/interno/limpeza) e
-- 'limpeza_segredo' (o mesmo valor de LIMPEZA_SECRET). Sem os dois, não faz nada.
create function app.chamar_limpeza()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url  text;
  v_seg  text;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    return;
  end if;
  execute $q$ select max(decrypted_secret) filter (where name = 'limpeza_url'),
                     max(decrypted_secret) filter (where name = 'limpeza_segredo')
                from vault.decrypted_secrets where name in ('limpeza_url', 'limpeza_segredo') $q$
     into v_url, v_seg;
  if v_url is null or v_seg is null or v_url !~ '^https://' then
    return;
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := ''{}''::jsonb, timeout_milliseconds := 30000)'
    using v_url, jsonb_build_object('Authorization', 'Bearer ' || v_seg, 'Content-Type', 'application/json');
end;
$$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    execute $c$ select cron.schedule('encerrar-bancas-paradas', '*/5 * * * *', 'select app.auto_end_bancas()') $c$;
    execute $c$ select cron.schedule('retencao', '17 * * * *', 'select app.retencao()') $c$;
    execute $c$ select cron.schedule('chamar-limpeza', '23 * * * *', 'select app.chamar_limpeza()') $c$;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke all on function
  app.tombstone(), app.enqueue_viewer_purge(uuid), app.erase_order_personal(uuid),
  app.end_banca(uuid, uuid, text, text), app.auto_end_bancas(), app.retencao(), app.chamar_limpeza(),
  api.srv_viewer_add_attachment(bytea, uuid, text, integer, integer, integer, bytea),
  api.srv_viewer_attachment_path(bytea, uuid), api.staff_attachment_path(uuid), api.srv_viewer_delete(bytea),
  api.staff_end_banca(uuid, text, uuid), api.srv_maintenance(), api.srv_purge_batch(integer),
  api.srv_purge_done(bigint[], bigint[], uuid[], uuid[], text)
from public, anon, authenticated, service_role;

grant execute on function api.staff_attachment_path(uuid), api.staff_end_banca(uuid, text, uuid) to authenticated;
grant execute on function
  api.srv_viewer_add_attachment(bytea, uuid, text, integer, integer, integer, bytea),
  api.srv_viewer_attachment_path(bytea, uuid), api.srv_viewer_delete(bytea),
  api.srv_maintenance(), api.srv_purge_batch(integer), api.srv_purge_done(bigint[], bigint[], uuid[], uuid[], text)
to service_role;
