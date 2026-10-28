-- =====================================================================
-- Etapa 1 · Log de auditoria append-only com encadeamento de hash
-- ARCHITECTURE §3.6 e DECISIONS D-019.
-- Garantias:
--   * nenhum papel da aplicação (anon, authenticated, service_role) tem
--     INSERT/UPDATE/DELETE/TRUNCATE (ver migração de RLS e grants);
--   * triggers bloqueiam UPDATE/DELETE/TRUNCATE até para o dono, exceto
--     dentro de app.purge_audit_log() (retenção de 12 meses);
--   * o encadeamento SHA-256 torna detectável qualquer alteração feita
--     por quem desative os triggers (dono/superusuário).
-- =====================================================================

create table app.audit_log (
  id             bigint generated always as identity primary key,
  -- Posição na cadeia, atribuída sob lock (a ordem dos ids pode diferir da ordem de commit).
  chain_pos      bigint not null unique,
  at             timestamptz not null default now(),
  actor_id       uuid,
  actor_role     text not null,
  action         text not null,
  banca_id       uuid,
  order_id       uuid,
  target_user_id uuid,
  detail         jsonb,
  request_id     uuid,
  prev_hash      bytea not null,
  row_hash       bytea not null,
  constraint audit_actor_role_ck check (actor_role in ('owner', 'moderator', 'sistema')),
  constraint audit_actor_ck check ((actor_role = 'sistema') = (actor_id is null)),
  constraint audit_action_ck check (action ~ '^[a-z_]{3,40}$'),
  constraint audit_hash_ck check (octet_length(row_hash) = 32)
);
create index audit_log_at_idx on app.audit_log (at);
create index audit_log_order_idx on app.audit_log (order_id) where order_id is not null;
create index audit_log_banca_idx on app.audit_log (banca_id) where banca_id is not null;

-- Âncora da cadeia depois da exclusão por retenção (uma única linha).
create table app.audit_anchor (
  id               smallint primary key default 1 check (id = 1),
  last_purged_pos  bigint not null,
  last_purged_hash bytea not null,
  purged_at        timestamptz not null
);

-- Chaves permitidas em `detail`. Nunca CPF, Pix, nome, token ou IP.
create function app.audit_detail_ok(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and octet_length(p::text) <= 2000
    and not exists (
      select 1
      from jsonb_object_keys(p) as k(key)
      where k.key <> all (array[
        'campo', 'motivo', 'de', 'para', 'tipo', 'escopo', 'expira_em', 'quantidade',
        'recebidos', 'pagos', 'recusados', 'total_pago_cents', 'sobra_cents',
        'nome_antigo', 'nome_novo', 'valor_cents', 'vagas', 'ip_limit',
        'moderador_anterior', 'sessao', 'dispositivo_novo', 'automatico', 'resultado'
      ])
    )
  )
$$;

alter table app.audit_log
  add constraint audit_detail_ck check (app.audit_detail_ok(detail));

-- Texto canônico de uma linha (entrada do hash).
create function app.audit_canonical(r app.audit_log)
returns text
language sql
stable
set search_path = ''
as $$
  select concat_ws('|',
    r.chain_pos::text,
    r.id::text,
    to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.actor_id::text, ''),
    r.actor_role,
    r.action,
    coalesce(r.banca_id::text, ''),
    coalesce(r.order_id::text, ''),
    coalesce(r.target_user_id::text, ''),
    coalesce(r.detail::text, ''),
    coalesce(r.request_id::text, '')
  )
$$;

-- Chave do advisory lock que serializa a cadeia.
create function app.audit_lock_key()
returns bigint
language sql
immutable
set search_path = ''
as $$ select 7342001::bigint $$;

create function app.audit_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev_pos  bigint;
  v_prev_hash bytea;
begin
  perform pg_advisory_xact_lock(app.audit_lock_key());

  select chain_pos, row_hash into v_prev_pos, v_prev_hash
  from app.audit_log
  order by chain_pos desc
  limit 1;

  if v_prev_pos is null then
    select last_purged_pos, last_purged_hash into v_prev_pos, v_prev_hash
    from app.audit_anchor where id = 1;
  end if;

  new.chain_pos := coalesce(v_prev_pos, 0) + 1;
  new.prev_hash := coalesce(v_prev_hash, '\x'::bytea);
  new.row_hash := sha256(new.prev_hash || convert_to(app.audit_canonical(new), 'UTF8'));
  return new;
end;
$$;

create trigger audit_log_chain
  before insert on app.audit_log
  for each row execute function app.audit_chain();

create function app.audit_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and current_setting('app.audit_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_log é somente inserção (%)', tg_op using errcode = '42501';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on app.audit_log
  for each row execute function app.audit_guard();

create trigger audit_log_no_truncate
  before truncate on app.audit_log
  for each statement execute function app.audit_guard();

-- Única forma de gravar auditoria. Chamada só por outras funções do banco.
create function app.audit(
  p_action     text,
  p_actor_id   uuid,
  p_actor_role text,
  p_banca_id   uuid default null,
  p_order_id   uuid default null,
  p_target     uuid default null,
  p_detail     jsonb default null,
  p_request_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  -- chain_pos, prev_hash e row_hash são preenchidos pelo trigger audit_log_chain.
  insert into app.audit_log (actor_id, actor_role, action, banca_id, order_id, target_user_id, detail, request_id)
  values (p_actor_id, p_actor_role, p_action, p_banca_id, p_order_id, p_target, p_detail, p_request_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- Verifica a cadeia inteira. Retorna a chain_pos da primeira linha inválida, ou NULL se íntegra.
create function app.audit_verify()
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r      app.audit_log;
  v_prev bytea;
  v_pos  bigint;
begin
  select last_purged_hash, last_purged_pos into v_prev, v_pos from app.audit_anchor where id = 1;
  v_prev := coalesce(v_prev, '\x'::bytea);
  v_pos := coalesce(v_pos, 0);

  for r in select * from app.audit_log order by chain_pos loop
    if r.chain_pos <> v_pos + 1
       or r.prev_hash <> v_prev
       or r.row_hash <> sha256(r.prev_hash || convert_to(app.audit_canonical(r), 'UTF8')) then
      return r.chain_pos;
    end if;
    v_prev := r.row_hash;
    v_pos := r.chain_pos;
  end loop;
  return null;
end;
$$;

-- Retenção: apaga o trecho INICIAL contínuo da cadeia com mais de 12 meses e ancora
-- a cadeia. Nunca apaga uma linha recente, mesmo que existam linhas antigas depois
-- dela (a cadeia continua verificável). Chamada pelo pg_cron (Etapa 6).
create function app.purge_audit_log()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_corte          timestamptz := now() - interval '12 months';
  v_primeiro_novo  bigint;
  v_last           app.audit_log;
  v_n              integer;
begin
  perform pg_advisory_xact_lock(app.audit_lock_key());

  select min(chain_pos) into v_primeiro_novo from app.audit_log where at >= v_corte;

  select * into v_last
    from app.audit_log
   where at < v_corte
     and (v_primeiro_novo is null or chain_pos < v_primeiro_novo)
   order by chain_pos desc
   limit 1;

  if not found then
    return 0;
  end if;

  perform set_config('app.audit_purge', 'on', true);
  delete from app.audit_log where chain_pos <= v_last.chain_pos;
  get diagnostics v_n = row_count;
  perform set_config('app.audit_purge', 'off', true);

  insert into app.audit_anchor (id, last_purged_pos, last_purged_hash, purged_at)
  values (1, v_last.chain_pos, v_last.row_hash, now())
  on conflict (id) do update
    set last_purged_pos = excluded.last_purged_pos,
        last_purged_hash = excluded.last_purged_hash,
        purged_at = excluded.purged_at;

  return v_n;
end;
$$;
