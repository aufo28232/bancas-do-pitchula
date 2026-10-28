-- =====================================================================
-- Etapa 1 · Tabelas, constraints e índices (ARCHITECTURE §3)
-- Convenções:
--   *_enc  = texto cifrado AES-256-GCM no formato v{n}:{base64url}
--   *_hmac = HMAC-SHA256 (32 bytes) do valor normalizado
-- =====================================================================

-- Formato do texto cifrado gerado pela aplicação.
create function app.is_ciphertext(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- (o regex do Postgres limita repetições a 255, por isso o tamanho é checado à parte)
  select p ~ '^v[0-9]{1,4}:[A-Za-z0-9_-]+$' and char_length(p) between 27 and 4096
$$;

-- ---------------------------------------------------------------------
-- Staff e autenticação
-- ---------------------------------------------------------------------
create table app.staff (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  role           app.staff_role not null,
  display_name   text not null,
  active         boolean not null default true,
  created_by     uuid references app.staff (user_id) on delete set null,
  created_at     timestamptz not null default now(),
  deactivated_at timestamptz,
  constraint staff_display_name_ck
    check (char_length(display_name) between 2 and 32 and display_name ~ '^[[:alnum:] ._-]+$'),
  constraint staff_deactivated_ck
    check ((active and deactivated_at is null) or (not active and deactivated_at is not null))
);
-- Um único streamer (owner) ativo.
create unique index staff_um_owner_ativo on app.staff (role) where role = 'owner' and active;

create table app.staff_invites (
  id           uuid primary key default gen_random_uuid(),
  token_hash   bytea not null unique,
  display_name text not null,
  created_by   uuid not null references app.staff (user_id) on delete restrict,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_by      uuid references auth.users (id) on delete set null,
  revoked_at   timestamptz,
  constraint staff_invites_token_ck check (octet_length(token_hash) = 32),
  constraint staff_invites_display_name_ck
    check (char_length(display_name) between 2 and 32 and display_name ~ '^[[:alnum:] ._-]+$'),
  constraint staff_invites_validade_ck
    check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  constraint staff_invites_uso_ck check (not (used_at is not null and revoked_at is not null)),
  constraint staff_invites_used_by_ck check ((used_at is null) = (used_by is null))
);

create table app.known_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references app.staff (user_id) on delete cascade,
  device_hash   bytea not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint known_devices_hash_ck check (octet_length(device_hash) = 32),
  constraint known_devices_unq unique (user_id, device_hash)
);

create table app.staff_sessions (
  session_id      uuid primary key,
  user_id         uuid not null references app.staff (user_id) on delete cascade,
  device_id       uuid references app.known_devices (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  live_mode       boolean not null default true,
  approx_location text,
  ua_summary      text,
  revoked_at      timestamptz,
  revoked_by      uuid references app.staff (user_id) on delete set null,
  constraint staff_sessions_location_ck check (approx_location is null or char_length(approx_location) <= 80),
  constraint staff_sessions_ua_ck check (ua_summary is null or char_length(ua_summary) <= 80)
);
create index staff_sessions_ativas_idx on app.staff_sessions (user_id) where revoked_at is null;

create table app.security_alerts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references app.staff (user_id) on delete cascade,
  session_id      uuid,
  kind            text not null,
  created_at      timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references app.staff (user_id) on delete set null,
  constraint security_alerts_kind_ck check (kind in ('novo_dispositivo', 'encerramento_por_moderador', 'retencao_falhou'))
);
create index security_alerts_pendentes_idx on app.security_alerts (created_at) where acknowledged_at is null;

-- ---------------------------------------------------------------------
-- Bancas
-- ---------------------------------------------------------------------
create table app.bancas (
  id               uuid primary key default gen_random_uuid(),
  -- Vira NULL no encerramento: o link deixa de existir (D-044).
  code             text unique,
  -- Mantido para que um código nunca seja reaproveitado.
  code_hash        bytea not null unique,
  name             text not null,
  total_cents      bigint not null,
  slots            integer not null,
  -- Divisão inteira = arredonda para baixo. O CASE evita divisão por zero antes do CHECK de vagas.
  per_person_cents bigint generated always as (case when slots > 0 then total_cents / slots end) stored,
  remainder_cents  bigint generated always as (case when slots > 0 then total_cents - (total_cents / slots) * slots end) stored,
  ip_limit         boolean not null default true,
  -- Teto de pendentes = fator × vagas restantes (D-032).
  pending_factor   smallint not null default 3,
  status           app.banca_status not null default 'aberta',
  paid_count       integer not null default 0,
  order_count      integer not null default 0,
  last_activity_at timestamptz not null default now(),
  created_by       uuid not null references app.staff (user_id) on delete restrict,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz,
  sold_out_at      timestamptz,
  ended_at         timestamptz,
  ended_by         uuid references app.staff (user_id) on delete set null,
  version          integer not null default 1,
  constraint bancas_code_ck check (code is null or code ~ '^[a-z0-9]{8}-[0-9]{4}$'),
  constraint bancas_code_hash_ck check (octet_length(code_hash) = 32),
  constraint bancas_name_ck check (char_length(btrim(name)) between 1 and 80),
  -- Teto do banco: R$ 1 milhão; a aplicação limita a R$ 100 mil por padrão (D-042).
  constraint bancas_total_ck check (total_cents > 0 and total_cents <= 100000000),
  constraint bancas_slots_ck check (slots between 1 and 10000),
  constraint bancas_por_pessoa_ck check (total_cents >= slots),
  constraint bancas_pending_factor_ck check (pending_factor between 1 and 20),
  constraint bancas_paid_ck check (paid_count between 0 and slots),
  constraint bancas_order_count_ck check (order_count >= 0),
  constraint bancas_esgotada_ck check (status <> 'esgotada' or (paid_count = slots and sold_out_at is not null)),
  constraint bancas_fechada_ck check (status <> 'fechada' or closed_at is not null),
  constraint bancas_encerrada_ck check ((status = 'encerrada') = (ended_at is not null)),
  constraint bancas_encerrada_code_ck check ((status = 'encerrada') = (code is null))
);
create index bancas_status_idx on app.bancas (status);
create index bancas_fechadas_idx on app.bancas (closed_at) where status = 'fechada';
create index bancas_esgotadas_idx on app.bancas (sold_out_at) where status = 'esgotada';
create index bancas_abertas_idx on app.bancas (last_activity_at) where status = 'aberta';

-- code_hash é calculado pelo banco e nunca muda; code só pode virar NULL.
create function app.bancas_code_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.code is null then
      raise exception 'banca nova precisa de código' using errcode = '23502';
    end if;
    new.code_hash := sha256(convert_to(new.code, 'UTF8'));
  else
    if new.code_hash is distinct from old.code_hash then
      raise exception 'code_hash é imutável' using errcode = '55000';
    end if;
    if new.code is distinct from old.code and new.code is not null then
      raise exception 'o código da banca só pode ser removido, nunca trocado' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

create trigger bancas_code_guard
  before insert or update on app.bancas
  for each row execute function app.bancas_code_guard();

create table app.banca_stats (
  banca_id         uuid primary key references app.bancas (id) on delete cascade,
  received         integer not null default 0 check (received >= 0),
  paid             integer not null default 0 check (paid >= 0),
  refused          integer not null default 0 check (refused >= 0),
  total_paid_cents bigint not null default 0 check (total_paid_cents >= 0),
  remainder_cents  bigint not null default 0 check (remainder_cents >= 0)
);

-- ---------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------
create table app.orders (
  id                uuid primary key,
  banca_id          uuid not null references app.bancas (id) on delete restrict,
  seq               bigint generated always as identity,
  status            app.order_status not null default 'pendente',
  full_name_enc     text not null,
  cpf_enc           text not null,
  pix_type          app.pix_key_type not null,
  pix_key_enc       text not null,
  platform_id_enc   text not null,
  cpf_hmac          bytea not null,
  pix_hmac          bytea not null,
  platform_id_hmac  bytea not null,
  ip_hmac           bytea not null,
  hmac_key_version  smallint not null,
  ip_unique         boolean not null,
  access_token_hash bytea not null unique,
  token_revoked_at  timestamptz,
  viewer_uid        uuid,
  locked_by         uuid references app.staff (user_id) on delete restrict,
  locked_at         timestamptz,
  lock_activity_at  timestamptz,
  -- Prazo de resposta do espectador (D-043).
  reply_deadline_at timestamptz,
  paid_by           uuid references app.staff (user_id) on delete restrict,
  paid_at           timestamptz,
  refused_by        uuid references app.staff (user_id) on delete restrict,
  refused_at        timestamptz,
  refusal_reason    app.refusal_reason,
  refusal_note      text,
  has_receipt       boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint orders_enc_ck check (
    app.is_ciphertext(full_name_enc) and app.is_ciphertext(cpf_enc)
    and app.is_ciphertext(pix_key_enc) and app.is_ciphertext(platform_id_enc)
  ),
  constraint orders_hmac_ck check (
    octet_length(cpf_hmac) = 32 and octet_length(pix_hmac) = 32
    and octet_length(platform_id_hmac) = 32 and octet_length(ip_hmac) = 32
  ),
  constraint orders_token_ck check (octet_length(access_token_hash) = 32),
  constraint orders_hmac_version_ck check (hmac_key_version >= 1),
  constraint orders_pago_ck check ((status = 'pago') = (paid_at is not null and paid_by is not null)),
  constraint orders_recusado_ck check ((status = 'recusado') = (refused_at is not null and refusal_reason is not null)),
  constraint orders_trava_ck check (status = 'pendente' or (locked_by is null and reply_deadline_at is null)),
  constraint orders_trava_campos_ck check ((locked_by is null) = (locked_at is null and lock_activity_at is null)),
  constraint orders_prazo_ck check (reply_deadline_at is null or locked_by is not null),
  constraint orders_note_ck check (refusal_note is null or char_length(refusal_note) <= 280),
  -- Anti-duplicidade por CPF, garantida pelo banco (enunciado §2).
  constraint orders_cpf_por_banca_unq unique (banca_id, cpf_hmac)
);
-- 1 pedido por IP quando a opção estava ligada na criação (D-010).
create unique index orders_ip_por_banca_unq on app.orders (banca_id, ip_hmac) where ip_unique;
create index orders_fila_idx on app.orders (banca_id, status, seq);
create index orders_viewer_idx on app.orders (viewer_uid) where viewer_uid is not null;
create index orders_travados_idx on app.orders (locked_by) where locked_by is not null;
create index orders_prazo_idx on app.orders (reply_deadline_at) where reply_deadline_at is not null;
create index orders_pix_idx on app.orders (banca_id, pix_hmac);
create index orders_platform_idx on app.orders (banca_id, platform_id_hmac);

create function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger orders_updated_at
  before update on app.orders
  for each row execute function app.touch_updated_at();

create table app.order_sessions (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references app.orders (id) on delete cascade,
  session_hash bytea not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  constraint order_sessions_hash_ck check (octet_length(session_hash) = 32)
);
create index order_sessions_order_idx on app.order_sessions (order_id);

create table app.order_attachments (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references app.orders (id) on delete cascade,
  storage_path text not null unique,
  bytes        integer not null check (bytes between 1 and 5242880),
  width        integer not null check (width between 1 and 8000),
  height       integer not null check (height between 1 and 8000),
  sha256       bytea not null check (octet_length(sha256) = 32),
  created_at   timestamptz not null default now(),
  constraint order_attachments_path_ck
    check (storage_path ~ '^comprovantes/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.webp$')
);
create index order_attachments_order_idx on app.order_attachments (order_id);
create index order_attachments_sha_idx on app.order_attachments (sha256);

create table app.order_messages (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references app.orders (id) on delete cascade,
  author        app.msg_author not null,
  staff_id      uuid references app.staff (user_id) on delete restrict,
  body          text,
  attachment_id uuid references app.order_attachments (id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint order_messages_staff_ck check ((author = 'staff') = (staff_id is not null)),
  constraint order_messages_body_ck check (body is null or char_length(body) between 1 and 1000),
  constraint order_messages_conteudo_ck check (body is not null or attachment_id is not null)
);
create index order_messages_order_idx on app.order_messages (order_id, created_at);

-- Fila de arquivos a apagar do Storage (a API do Storage é a única forma de apagar o arquivo).
create table app.storage_purge_queue (
  id           bigint generated always as identity primary key,
  storage_path text not null,
  enqueued_at  timestamptz not null default now(),
  attempts     integer not null default 0 check (attempts >= 0),
  last_error   text,
  done_at      timestamptz
);
create index storage_purge_pendentes_idx on app.storage_purge_queue (enqueued_at) where done_at is null;

create function app.enqueue_attachment_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into app.storage_purge_queue (storage_path) values (old.storage_path);
  return old;
end;
$$;

create trigger order_attachments_purge
  after delete on app.order_attachments
  for each row execute function app.enqueue_attachment_purge();

-- ---------------------------------------------------------------------
-- Moderação
-- ---------------------------------------------------------------------
create table app.bans (
  id               uuid primary key default gen_random_uuid(),
  kind             app.ban_kind not null,
  value_hmac       bytea not null,
  hmac_key_version smallint not null,
  scope            app.ban_scope not null,
  banca_id         uuid references app.bancas (id) on delete cascade,
  reason           text not null,
  -- Sem FK: o pedido pode ser apagado antes do ban.
  source_order_id  uuid,
  created_by       uuid not null references app.staff (user_id) on delete restrict,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,
  review_due_at    timestamptz,
  lifted_at        timestamptz,
  lifted_by        uuid references app.staff (user_id) on delete set null,
  constraint bans_hmac_ck check (octet_length(value_hmac) = 32),
  constraint bans_reason_ck check (char_length(btrim(reason)) between 3 and 280),
  constraint bans_scope_ck check ((scope = 'banca') = (banca_id is not null)),
  -- IP: expiração obrigatória e no máximo 7 dias, em qualquer escopo (enunciado §4).
  constraint bans_ip_ck check (
    kind <> 'ip' or (expires_at is not null and expires_at > created_at and expires_at <= created_at + interval '7 days')
  ),
  constraint bans_revisao_ck check (kind = 'ip' or review_due_at is not null),
  constraint bans_lifted_ck check ((lifted_at is null) = (lifted_by is null))
);
create index bans_ativos_idx on app.bans (kind, value_hmac) where lifted_at is null;
create index bans_revisao_idx on app.bans (review_due_at) where lifted_at is null and kind <> 'ip';

create table app.quick_replies (
  id         uuid primary key default gen_random_uuid(),
  label      text not null check (char_length(btrim(label)) between 1 and 40),
  body       text not null check (char_length(btrim(body)) between 1 and 500),
  sort       integer not null default 0,
  active     boolean not null default true,
  -- NULL = resposta padrão criada pelo sistema.
  created_by uuid references app.staff (user_id) on delete set null,
  created_at timestamptz not null default now()
);

insert into app.quick_replies (label, body, sort) values
  ('Comprovante ilegível', 'Não deu pra ler o comprovante. Manda outro print, por favor, com o valor e a data aparecendo.', 10),
  ('Depósito não encontrado', 'Não encontrei esse depósito. Confere se o ID e o CPF que você informou são os mesmos da sua conta na plataforma.', 20),
  ('Pago', 'Pago, boa sorte!', 30);

-- ---------------------------------------------------------------------
-- Idempotência
-- ---------------------------------------------------------------------
create table app.idempotency_keys (
  actor_id   uuid not null,
  key        uuid not null,
  action     text not null,
  target_id  uuid,
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (actor_id, key)
);
create index idempotency_keys_criadas_idx on app.idempotency_keys (created_at);
