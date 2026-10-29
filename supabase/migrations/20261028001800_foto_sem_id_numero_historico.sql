-- =====================================================================
-- Pedido do streamer (DECISIONS D-089):
--  1. Foto da banca: 1win ou Chillbet (ou a padrão).
--  2. ID na casa deixa de ser pedido: colunas do ID passam a aceitar vazio.
--  3. Número do pedido por banca (#1, #2... em cada banca), no lugar do global.
--  4. Streamer apaga o histórico de bancas encerradas.
-- =====================================================================

-- 1. Foto --------------------------------------------------------------------
alter table app.bancas
  add column foto text,
  add constraint bancas_foto_ck check (foto is null or foto in ('1win', 'chillbet'));

-- 2. ID na casa opcional (pedidos antigos continuam com o deles) ---------------
alter table app.orders
  alter column platform_id_enc drop not null,
  alter column platform_id_hmac drop not null,
  drop constraint orders_enc_ck,
  drop constraint orders_hmac_ck,
  add constraint orders_enc_ck check (
    app.is_ciphertext(full_name_enc) and app.is_ciphertext(cpf_enc)
    and app.is_ciphertext(pix_key_enc)
    and (platform_id_enc is null or app.is_ciphertext(platform_id_enc))
  ),
  add constraint orders_hmac_ck check (
    octet_length(cpf_hmac) = 32 and octet_length(pix_hmac) = 32
    and (platform_id_hmac is null or octet_length(platform_id_hmac) = 32) and octet_length(ip_hmac) = 32
  ),
  add constraint orders_pid_par_ck check ((platform_id_enc is null) = (platform_id_hmac is null));

-- 3. Número por banca ------------------------------------------------------------
alter table app.bancas add column pedidos_numerados integer not null default 0;
alter table app.orders add column numero integer;

with n as (select id, row_number() over (partition by banca_id order by seq) as rn from app.orders)
update app.orders o set numero = n.rn from n where n.id = o.id;
update app.bancas b
   set pedidos_numerados = coalesce((select max(o.numero) from app.orders o where o.banca_id = b.id), 0);

alter table app.orders alter column numero set not null;
alter table app.orders add constraint orders_numero_unq unique (banca_id, numero);

-- Trava a linha da banca: dois pedidos ao mesmo tempo nunca pegam o mesmo número.
-- Se o insert falhar (duplicado), o savepoint desfaz também este contador.
create function app.numerar_pedido()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app.bancas set pedidos_numerados = pedidos_numerados + 1
   where id = new.banca_id
  returning pedidos_numerados into new.numero;
  return new;
end;
$$;
revoke all on function app.numerar_pedido() from public, anon, authenticated, service_role;

create trigger orders_numero
  before insert on app.orders
  for each row execute function app.numerar_pedido();

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
      'id', o.id, 'seq', o.seq, 'numero', o.numero, 'status', o.status, 'criado_em', o.created_at,
      'atendente', case when app.lock_active(o) then app.staff_name(o.locked_by) end,
      'meu', app.lock_active(o) and o.locked_by = auth.uid(),
      'prazo', o.reply_deadline_at, 'motivo', o.refusal_reason, 'nota', o.refusal_note,
      'tem_comprovante', o.has_receipt, 'pix_tipo', o.pix_type, 'apagado', o.data_erased_at is not null,
      'pago_por', app.staff_name(o.paid_by), 'pago_em', o.paid_at,
      'recusado_por', app.staff_name(o.refused_by), 'recusado_em', o.refused_at,
      'enc', jsonb_build_object('nome', o.full_name_enc, 'cpf', o.cpf_enc, 'pix', o.pix_key_enc, 'pid', o.platform_id_enc)
    ),
    -- Sinais de fraude (T9): mesmos dados em outros pedidos da banca, mesmo comprovante em outro pedido.
    'sinais', jsonb_build_object(
      'mesmo_pix', (select count(*) from app.orders x
                     where x.banca_id = o.banca_id and x.id <> o.id and x.pix_hmac = o.pix_hmac and o.data_erased_at is null),
      'mesmo_id', (select count(*) from app.orders x
                    where x.banca_id = o.banca_id and x.id <> o.id and x.platform_id_hmac = o.platform_id_hmac and o.data_erased_at is null),
      'comprovante_repetido', (select count(distinct outro.order_id) from app.order_attachments meu
                                 join app.order_attachments outro on outro.sha256 = meu.sha256 and outro.order_id <> meu.order_id
                                where meu.order_id = o.id)
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

-- 4. Apagar histórico ----------------------------------------------------------
-- Só bancas ENCERRADAS (pedidos, chat e comprovantes já foram apagados no
-- encerramento). Leva junto o resumo e os bans "só desta banca". A auditoria fica.
create function api.owner_clear_history()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform app.require_owner();
  with apagadas as (
    delete from app.bancas where status = 'encerrada' returning id
  )
  select count(*)::int into v_n from apagadas;
  perform app.audit('historico_apagado', auth.uid(), 'owner', p_detail => jsonb_build_object('quantidade', v_n));
  return v_n;
end;
$$;
revoke all on function api.owner_clear_history() from public, anon, authenticated, service_role;
grant execute on function api.owner_clear_history() to authenticated;

-- 1. (cont.) Funções que passam a ler/gravar a foto -------------------------------
drop function api.owner_create_banca(text, text, bigint, integer, boolean, uuid, text, text);
drop function api.owner_update_banca(uuid, integer, text, bigint, integer, boolean, text, text);
drop function api.staff_list_bancas();
drop function api.public_get_banca(text);

create function api.owner_create_banca(
  p_code        text,
  p_name        text,
  p_total_cents bigint,
  p_slots       integer,
  p_ip_limit    boolean,
  p_idem        uuid,
  p_platform_name text default null,
  p_signup_url    text default null,
  p_foto          text default null
)
returns table (id uuid, code text, per_person_cents bigint, remainder_cents bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_role app.staff_role;
  v_prev jsonb;
  v_id   uuid;
begin
  v_role := app.require_staff();

  v_prev := app.idem_get(auth.uid(), p_idem, 'banca_criar', null);
  if v_prev is not null then
    return query select b.id, b.code, b.per_person_cents, b.remainder_cents
                   from app.bancas b where b.id = (v_prev ->> 'id')::uuid;
    return;
  end if;

  insert into app.bancas (code, name, total_cents, slots, ip_limit, created_by, platform_name, signup_url, foto)
  values (p_code, btrim(p_name), p_total_cents, p_slots, coalesce(p_ip_limit, true), auth.uid(),
          nullif(btrim(p_platform_name), ''), nullif(btrim(p_signup_url), ''), nullif(btrim(p_foto), ''))
  returning app.bancas.id into v_id;

  insert into app.banca_stats (banca_id, remainder_cents)
  select v_id, b.remainder_cents from app.bancas b where b.id = v_id;

  perform app.idem_put(auth.uid(), p_idem, 'banca_criar', null, jsonb_build_object('id', v_id));
  perform app.audit('banca_criar', auth.uid(), v_role::text, p_banca_id => v_id,
                    p_detail => jsonb_build_object('valor_cents', p_total_cents, 'vagas', p_slots, 'ip_limit', coalesce(p_ip_limit, true),
                                                         'casa', nullif(btrim(p_platform_name), '')));

  -- Moderador mexeu em banca: o streamer recebe um alerta no painel (D-088).
  if v_role = 'moderator' then
    insert into app.security_alerts (user_id, kind)
    select user_id, 'banca_por_moderador' from app.staff where role = 'owner' and active;
  end if;

  return query select b.id, b.code, b.per_person_cents, b.remainder_cents from app.bancas b where b.id = v_id;
end;
$$;

create function api.owner_update_banca(
  p_id          uuid,
  p_version     integer,
  p_name        text,
  p_total_cents bigint default null,
  p_slots       integer default null,
  p_ip_limit    boolean default null,
  p_platform_name text default null,
  p_signup_url    text default null,
  p_foto          text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role;
  b app.bancas;
  v_detail jsonb := '{}'::jsonb;
begin
  v_role := app.require_staff();

  select * into b from app.bancas where id = p_id for update;
  if not found or b.status = 'encerrada' then
    raise exception 'banca não encontrada' using errcode = 'P0002';
  end if;
  if b.version <> p_version then
    raise exception 'a banca foi alterada por outra pessoa; recarregue' using errcode = '40001';
  end if;

  if (p_total_cents is not null and p_total_cents <> b.total_cents)
     or (p_slots is not null and p_slots <> b.slots) then
    if b.order_count > 0 then
      raise exception 'valor e vagas ficam travados depois do primeiro pedido' using errcode = '55000';
    end if;
    v_detail := v_detail || jsonb_build_object('valor_cents', coalesce(p_total_cents, b.total_cents),
                                               'vagas', coalesce(p_slots, b.slots));
  end if;

  -- Casa: travada depois do primeiro pedido (o ID e o CPF pedidos são dela). Link: sempre.
  if p_platform_name is not null and btrim(p_platform_name) is distinct from b.platform_name then
    if b.order_count > 0 then
      raise exception 'a casa fica travada depois do primeiro pedido' using errcode = '55000';
    end if;
    v_detail := v_detail || jsonb_build_object('casa', btrim(p_platform_name));
  end if;
  if p_signup_url is not null and nullif(btrim(p_signup_url), '') is distinct from b.signup_url then
    v_detail := v_detail || jsonb_build_object('link_afiliado', 'alterado');
  end if;

  if p_foto is not null and nullif(btrim(p_foto), '') is distinct from b.foto then
    v_detail := v_detail || jsonb_build_object('campo', 'foto');
  end if;

  if p_name is not null and btrim(p_name) <> b.name then
    v_detail := v_detail || jsonb_build_object('nome_antigo', b.name, 'nome_novo', btrim(p_name));
  end if;
  if p_ip_limit is not null and p_ip_limit <> b.ip_limit then
    v_detail := v_detail || jsonb_build_object('ip_limit', p_ip_limit);
  end if;

  update app.bancas
     set name        = coalesce(btrim(p_name), name),
         total_cents = coalesce(p_total_cents, total_cents),
         slots       = coalesce(p_slots, slots),
         ip_limit    = coalesce(p_ip_limit, ip_limit),
         platform_name = coalesce(nullif(btrim(p_platform_name), ''), platform_name),
         foto        = case when p_foto is null then foto else nullif(btrim(p_foto), '') end,
         signup_url  = case when p_signup_url is null then signup_url else nullif(btrim(p_signup_url), '') end,
         version     = version + 1
   where id = p_id;

  update app.banca_stats s
     set remainder_cents = b2.remainder_cents
    from app.bancas b2
   where s.banca_id = p_id and b2.id = p_id;

  if v_detail <> '{}'::jsonb then
    perform app.audit('banca_editar', auth.uid(), v_role::text, p_banca_id => p_id, p_detail => v_detail);
    -- Moderador mexeu em banca: o streamer recebe um alerta no painel (D-088).
    if v_role = 'moderator' then
      insert into app.security_alerts (user_id, kind)
      select user_id, 'banca_por_moderador' from app.staff where role = 'owner' and active;
    end if;
  end if;
  return b.version + 1;
end;
$$;

create function api.staff_list_bancas()
returns table (
  id uuid, code text, name text, total_cents bigint, slots integer, per_person_cents bigint,
  remainder_cents bigint, ip_limit boolean, status app.banca_status, paid_count integer,
  order_count integer, pendentes integer, version integer, created_at timestamptz,
  platform_name text, signup_url text, foto text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.require_staff();
  return query
    select b.id, b.code, b.name, b.total_cents, b.slots, b.per_person_cents, b.remainder_cents,
           b.ip_limit, b.status, b.paid_count, b.order_count,
           (select count(*)::int from app.orders o where o.banca_id = b.id and o.status = 'pendente'),
           b.version, b.created_at, b.platform_name, b.signup_url, b.foto
      from app.bancas b
     where b.status <> 'encerrada' or b.ended_at > now() - interval '30 days'
     order by (b.status = 'encerrada'), b.created_at desc;
end;
$$;

create function api.public_get_banca(p_code text)
returns table (name text, per_person_cents bigint, slots integer, restantes integer, status text,
               platform_name text, signup_url text, foto text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name, b.per_person_cents, b.slots, b.slots - b.paid_count, b.status::text, b.platform_name, b.signup_url, b.foto
    from app.bancas b
   where b.code = p_code
     and b.status <> 'encerrada'
$$;

revoke all on function
  api.owner_create_banca(text, text, bigint, integer, boolean, uuid, text, text, text),
  api.owner_update_banca(uuid, integer, text, bigint, integer, boolean, text, text, text),
  api.staff_list_bancas(),
  api.public_get_banca(text)
from public, anon, authenticated, service_role;

grant execute on function
  api.owner_create_banca(text, text, bigint, integer, boolean, uuid, text, text, text),
  api.owner_update_banca(uuid, integer, text, bigint, integer, boolean, text, text, text),
  api.staff_list_bancas()
to authenticated;

grant execute on function api.public_get_banca(text) to service_role;
