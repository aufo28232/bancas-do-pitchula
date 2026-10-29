-- =====================================================================
-- Moderadores também criam e gerenciam bancas (DECISIONS D-088, pedido do streamer)
--
-- Criar, editar, pausar e reabrir passam de "só streamer" para "equipe"
-- (encerrar já era da equipe, D-044). Os nomes owner_* ficam por compatibilidade.
-- A auditoria grava o papel real de quem agiu e, quando é um moderador, o
-- streamer recebe um alerta no painel (o link de afiliado é dinheiro: T22).
-- =====================================================================

alter table app.security_alerts drop constraint security_alerts_kind_ck;
alter table app.security_alerts add constraint security_alerts_kind_ck
  check (kind in ('novo_dispositivo', 'encerramento_por_moderador', 'retencao_falhou', 'banca_por_moderador'));

create or replace function api.owner_create_banca(
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

  insert into app.bancas (code, name, total_cents, slots, ip_limit, created_by, platform_name, signup_url)
  values (p_code, btrim(p_name), p_total_cents, p_slots, coalesce(p_ip_limit, true), auth.uid(),
          nullif(btrim(p_platform_name), ''), nullif(btrim(p_signup_url), ''))
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

create or replace function api.owner_update_banca(
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

create or replace function api.owner_set_banca_status(p_id uuid, p_acao text)
returns app.banca_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role;
  b app.bancas;
begin
  v_role := app.require_staff();
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

  perform app.audit('banca_status', auth.uid(), v_role::text, p_banca_id => p_id,
                    p_detail => jsonb_build_object('de', b.status::text, 'para', case p_acao when 'fechar' then 'fechada' else 'aberta' end));
  return (select status from app.bancas where id = p_id);
end;
$$;
