-- =====================================================================
-- Etapa 3 · Bancas (painel) e criação de pedido (público)
-- ARCHITECTURE §5.3, §5.4 · DECISIONS D-004, D-007, D-010, D-032, D-042
-- =====================================================================

-- Idempotência: devolve o resultado guardado ou NULL se a chave é nova.
-- Chave repetida com outra ação/alvo é erro (não replay).
create function app.idem_get(p_actor uuid, p_key uuid, p_action text, p_target uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r app.idempotency_keys;
begin
  if p_key is null then
    return null;
  end if;
  select * into r from app.idempotency_keys where actor_id = p_actor and key = p_key;
  if not found then
    return null;
  end if;
  if r.action <> p_action or r.target_id is distinct from p_target then
    raise exception 'chave de idempotência reutilizada em outra operação' using errcode = '22023';
  end if;
  return coalesce(r.result, '{}'::jsonb);
end;
$$;

create function app.idem_put(p_actor uuid, p_key uuid, p_action text, p_target uuid, p_result jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into app.idempotency_keys (actor_id, key, action, target_id, result)
  select p_actor, p_key, p_action, p_target, p_result
  where p_key is not null
$$;

-- ---------------------------------------------------------------------
-- Painel: bancas
-- ---------------------------------------------------------------------
create function api.owner_create_banca(
  p_code        text,
  p_name        text,
  p_total_cents bigint,
  p_slots       integer,
  p_ip_limit    boolean,
  p_idem        uuid
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

  insert into app.bancas (code, name, total_cents, slots, ip_limit, created_by)
  values (p_code, btrim(p_name), p_total_cents, p_slots, coalesce(p_ip_limit, true), auth.uid())
  returning app.bancas.id into v_id;

  insert into app.banca_stats (banca_id, remainder_cents)
  select v_id, b.remainder_cents from app.bancas b where b.id = v_id;

  perform app.idem_put(auth.uid(), p_idem, 'banca_criar', null, jsonb_build_object('id', v_id));
  perform app.audit('banca_criar', auth.uid(), 'owner', p_banca_id => v_id,
                    p_detail => jsonb_build_object('valor_cents', p_total_cents, 'vagas', p_slots, 'ip_limit', coalesce(p_ip_limit, true)));

  return query select b.id, b.code, b.per_person_cents, b.remainder_cents from app.bancas b where b.id = v_id;
end;
$$;

-- Edição: nome sempre; valor e vagas só sem nenhum pedido; "1 por IP" sempre (vale para os próximos, D-010).
create function api.owner_update_banca(
  p_id          uuid,
  p_version     integer,
  p_name        text,
  p_total_cents bigint default null,
  p_slots       integer default null,
  p_ip_limit    boolean default null
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

-- Fechar (pausa) e reabrir. Encerrar (apaga tudo) chega na Etapa 6.
create function api.owner_set_banca_status(p_id uuid, p_acao text)
returns app.banca_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  b app.bancas;
begin
  perform app.require_owner();
  select * into b from app.bancas where id = p_id for update;
  if not found or b.status = 'encerrada' then
    raise exception 'banca não encontrada' using errcode = 'P0002';
  end if;

  if p_acao = 'fechar' and b.status = 'aberta' then
    update app.bancas set status = 'fechada', closed_at = now(), version = version + 1 where id = p_id;
  elsif p_acao = 'reabrir' and b.status = 'fechada' then
    update app.bancas set status = 'aberta', closed_at = null, last_activity_at = now(), version = version + 1 where id = p_id;
  else
    raise exception 'transição de estado inválida' using errcode = '55000';
  end if;

  perform app.audit('banca_status', auth.uid(), 'owner', p_banca_id => p_id,
                    p_detail => jsonb_build_object('de', b.status::text, 'para', case p_acao when 'fechar' then 'fechada' else 'aberta' end));
  return (select status from app.bancas where id = p_id);
end;
$$;

create function api.staff_list_bancas()
returns table (
  id uuid, code text, name text, total_cents bigint, slots integer, per_person_cents bigint,
  remainder_cents bigint, ip_limit boolean, status app.banca_status, paid_count integer,
  order_count integer, pendentes integer, version integer, created_at timestamptz
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
           b.version, b.created_at
      from app.bancas b
     where b.status <> 'encerrada' or b.ended_at > now() - interval '30 days'
     order by (b.status = 'encerrada'), b.created_at desc;
end;
$$;

-- ---------------------------------------------------------------------
-- Público: página da banca
-- ---------------------------------------------------------------------
create function api.public_get_banca(p_code text)
returns table (name text, per_person_cents bigint, slots integer, restantes integer, status text)
language sql
stable
security definer
set search_path = ''
as $$
  select b.name, b.per_person_cents, b.slots, b.slots - b.paid_count, b.status::text
    from app.bancas b
   where b.code = p_code
     and b.status <> 'encerrada'
$$;

-- ---------------------------------------------------------------------
-- Público: criação de pedido (o servidor já validou Turnstile, Zod e rate limit,
-- e entrega os dados CIFRADOS e os HMACs). Resultados possíveis:
--   'ok' | 'indisponivel' (banca inexistente/não aberta) | 'bloqueado' (banido,
--   CPF ou IP repetido: a resposta ao usuário é a MESMA) | 'fila_cheia' (D-032)
-- Os arrays *_hmacs trazem o HMAC em TODAS as versões de chave aceitas (D-013),
-- para que banimentos e duplicidade continuem valendo durante uma rotação.
-- ---------------------------------------------------------------------
create function api.public_create_order(
  p_code              text,
  p_id                uuid,
  p_full_name_enc     text,
  p_cpf_enc           text,
  p_pix_type          text,
  p_pix_key_enc       text,
  p_platform_id_enc   text,
  p_cpf_hmac          bytea,
  p_pix_hmac          bytea,
  p_platform_id_hmac  bytea,
  p_ip_hmac           bytea,
  p_hmac_version      smallint,
  p_cpf_hmacs         bytea[],
  p_pix_hmacs         bytea[],
  p_platform_id_hmacs bytea[],
  p_ip_hmacs          bytea[],
  p_access_token_hash bytea
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  b         app.bancas;
  v_motivo  text;
  v_pend    integer;
begin
  select * into b from app.bancas where code = p_code for update;
  if not found or b.status <> 'aberta' then
    return 'indisponivel';
  end if;

  -- Banimentos ativos (globais ou desta banca). Ban de IP vencido não vale.
  if exists (
    select 1 from app.bans x
     where x.lifted_at is null
       and (x.expires_at is null or x.expires_at > now())
       and (x.scope = 'global' or x.banca_id = b.id)
       and (   (x.kind = 'cpf'         and x.value_hmac = any(p_cpf_hmacs))
            or (x.kind = 'pix'         and x.value_hmac = any(p_pix_hmacs))
            or (x.kind = 'platform_id' and x.value_hmac = any(p_platform_id_hmacs))
            or (x.kind = 'ip'          and x.value_hmac = any(p_ip_hmacs)))
  ) then
    v_motivo := 'banido';
  -- Duplicidade (o UNIQUE pega a versão ativa; isto cobre as versões antigas).
  elsif exists (select 1 from app.orders o where o.banca_id = b.id and o.cpf_hmac = any(p_cpf_hmacs)) then
    v_motivo := 'cpf_repetido';
  elsif b.ip_limit and exists (
    select 1 from app.orders o where o.banca_id = b.id and o.ip_unique and o.ip_hmac = any(p_ip_hmacs)
  ) then
    v_motivo := 'ip_repetido';
  end if;

  if v_motivo is not null then
    perform app.audit('pedido_bloqueado', null, 'sistema', p_banca_id => b.id,
                      p_detail => jsonb_build_object('motivo', v_motivo));
    return 'bloqueado';
  end if;

  select count(*) into v_pend from app.orders o where o.banca_id = b.id and o.status = 'pendente';
  if v_pend >= b.pending_factor * (b.slots - b.paid_count) then
    return 'fila_cheia';
  end if;

  begin
    insert into app.orders (
      id, banca_id, full_name_enc, cpf_enc, pix_type, pix_key_enc, platform_id_enc,
      cpf_hmac, pix_hmac, platform_id_hmac, ip_hmac, hmac_key_version, ip_unique, access_token_hash
    ) values (
      p_id, b.id, p_full_name_enc, p_cpf_enc, p_pix_type::app.pix_key_type, p_pix_key_enc, p_platform_id_enc,
      p_cpf_hmac, p_pix_hmac, p_platform_id_hmac, p_ip_hmac, p_hmac_version, b.ip_limit, p_access_token_hash
    );
  exception
    when unique_violation then
      -- Corrida entre dois envios simultâneos: o banco decide.
      perform app.audit('pedido_bloqueado', null, 'sistema', p_banca_id => b.id,
                        p_detail => jsonb_build_object('motivo', 'concorrencia'));
      return 'bloqueado';
  end;

  update app.bancas set order_count = order_count + 1, last_activity_at = now() where id = b.id;
  update app.banca_stats set received = received + 1 where banca_id = b.id;

  insert into app.order_messages (order_id, author, body)
  values (p_id, 'sistema', 'Pedido recebido! Manda aqui o print do comprovante de depósito.');

  perform app.audit('pedido_criado', null, 'sistema', p_banca_id => b.id, p_order_id => p_id);
  return 'ok';
end;
$$;

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke all on function app.idem_get(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;
revoke all on function app.idem_put(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function
  api.owner_create_banca(text, text, bigint, integer, boolean, uuid),
  api.owner_update_banca(uuid, integer, text, bigint, integer, boolean),
  api.owner_set_banca_status(uuid, text),
  api.staff_list_bancas(),
  api.public_get_banca(text),
  api.public_create_order(text, uuid, text, text, text, text, text, bytea, bytea, bytea, bytea, smallint, bytea[], bytea[], bytea[], bytea[], bytea)
from public, anon, authenticated, service_role;

grant execute on function
  api.owner_create_banca(text, text, bigint, integer, boolean, uuid),
  api.owner_update_banca(uuid, integer, text, bigint, integer, boolean),
  api.owner_set_banca_status(uuid, text),
  api.staff_list_bancas()
to authenticated;

grant execute on function
  api.public_get_banca(text),
  api.public_create_order(text, uuid, text, text, text, text, text, bytea, bytea, bytea, bytea, smallint, bytea[], bytea[], bytea[], bytea[], bytea)
to service_role;
