-- =====================================================================
-- Casa de apostas e link de afiliado POR BANCA (DECISIONS D-086, pedido do streamer)
--
-- Cada banca diz em qual casa o espectador precisa ter conta e qual o link de
-- cadastro (afiliado). A página da banca usa esses dois no lugar de
-- PLATFORM_NAME / PLATFORM_SIGNUP_URL, que ficam só como padrão para bancas
-- antigas. O nome da casa trava depois do primeiro pedido; o link, não.
-- =====================================================================

alter table app.bancas
  add column platform_name text,
  add column signup_url text,
  add constraint bancas_platform_name_ck
    check (platform_name is null or char_length(platform_name) between 1 and 40),
  add constraint bancas_signup_url_ck
    check (signup_url is null or (signup_url ~ '^https://[^\s<>"]+$' and char_length(signup_url) <= 500));

-- Auditoria: aceita também 'casa' (nome da casa, não é dado pessoal) e
-- 'link_afiliado' (só o aviso "alterado", nunca o link).
create or replace function app.audit_detail_ok(p jsonb)
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
        'moderador_anterior', 'sessao', 'dispositivo_novo', 'automatico', 'resultado',
        'casa', 'link_afiliado'
      ])
    )
  )
$$;

-- Assinaturas/retornos mudam: recria as funções.
drop function api.owner_create_banca(text, text, bigint, integer, boolean, uuid);
drop function api.owner_update_banca(uuid, integer, text, bigint, integer, boolean);
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
  p_signup_url    text default null
)
returns table (id uuid, code text, per_person_cents bigint, remainder_cents bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_prev jsonb;
  v_id   uuid;
begin
  perform app.require_owner();

  v_prev := app.idem_get(auth.uid(), p_idem, 'banca_criar', null);
  if v_prev is not null then
    return query select b.id, b.code, b.per_person_cents, b.remainder_cents
                   from app.bancas b where b.id = (v_prev ->> 'id')::uuid;
    return;
  end if;

  insert into app.bancas (code, name, total_cents, slots, ip_limit, created_by, platform_name, signup_url)
  values (p_code, btrim(p_name), p_total_cents, p_slots, coalesce(p_ip_limit, true), auth.uid(),
          nullif(btrim(p_platform_name), ''), nullif(btrim(p_signup_url), ''))
  returning app.bancas.id into v_id;

  insert into app.banca_stats (banca_id, remainder_cents)
  select v_id, b.remainder_cents from app.bancas b where b.id = v_id;

  perform app.idem_put(auth.uid(), p_idem, 'banca_criar', null, jsonb_build_object('id', v_id));
  perform app.audit('banca_criar', auth.uid(), 'owner', p_banca_id => v_id,
                    p_detail => jsonb_build_object('valor_cents', p_total_cents, 'vagas', p_slots, 'ip_limit', coalesce(p_ip_limit, true),
                                                         'casa', nullif(btrim(p_platform_name), '')));

  return query select b.id, b.code, b.per_person_cents, b.remainder_cents from app.bancas b where b.id = v_id;
end;
$$;

-- Edição: nome e link sempre; valor, vagas e casa só sem nenhum pedido; "1 por IP" sempre (D-010).
create function api.owner_update_banca(
  p_id          uuid,
  p_version     integer,
  p_name        text,
  p_total_cents bigint default null,
  p_slots       integer default null,
  p_ip_limit    boolean default null,
  p_platform_name text default null,
  p_signup_url    text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  b app.bancas;
  v_detail jsonb := '{}'::jsonb;
begin
  perform app.require_owner();

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
         signup_url  = case when p_signup_url is null then signup_url else nullif(btrim(p_signup_url), '') end,
         version     = version + 1
   where id = p_id;

  update app.banca_stats s
     set remainder_cents = b2.remainder_cents
    from app.bancas b2
   where s.banca_id = p_id and b2.id = p_id;

  if v_detail <> '{}'::jsonb then
    perform app.audit('banca_editar', auth.uid(), 'owner', p_banca_id => p_id, p_detail => v_detail);
  end if;
  return b.version + 1;
end;
$$;

create function api.staff_list_bancas()
returns table (
  id uuid, code text, name text, total_cents bigint, slots integer, per_person_cents bigint,
  remainder_cents bigint, ip_limit boolean, status app.banca_status, paid_count integer,
  order_count integer, pendentes integer, version integer, created_at timestamptz,
  platform_name text, signup_url text
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
           b.version, b.created_at, b.platform_name, b.signup_url
      from app.bancas b
     where b.status <> 'encerrada' or b.ended_at > now() - interval '30 days'
     order by (b.status = 'encerrada'), b.created_at desc;
end;
$$;

create function api.public_get_banca(p_code text)
returns table (name text, per_person_cents bigint, slots integer, restantes integer, status text,
               platform_name text, signup_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name, b.per_person_cents, b.slots, b.slots - b.paid_count, b.status::text, b.platform_name, b.signup_url
    from app.bancas b
   where b.code = p_code
     and b.status <> 'encerrada'
$$;

revoke all on function
  api.owner_create_banca(text, text, bigint, integer, boolean, uuid, text, text),
  api.owner_update_banca(uuid, integer, text, bigint, integer, boolean, text, text),
  api.staff_list_bancas(),
  api.public_get_banca(text)
from public, anon, authenticated, service_role;

grant execute on function
  api.owner_create_banca(text, text, bigint, integer, boolean, uuid, text, text),
  api.owner_update_banca(uuid, integer, text, bigint, integer, boolean, text, text),
  api.staff_list_bancas()
to authenticated;

grant execute on function api.public_get_banca(text) to service_role;
