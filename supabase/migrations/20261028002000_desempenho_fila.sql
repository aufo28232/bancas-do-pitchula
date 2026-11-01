-- =====================================================================
-- Desempenho com fila cheia (DECISIONS D-091). Primeira live: inscrição girando,
-- pedidos que entravam no banco mas não abriam no navegador, pagamentos com
-- ~10 s de atraso. Causa: a cada pedido pago/recusado o banco mandava um aviso
-- de posição para CADA pessoa da fila (N mensagens de tempo real) segurando a
-- banca travada, e o painel recalculava a fila com uma contagem por pedido.
-- =====================================================================

-- 1. Sem aviso de posição por pessoa.
create or replace function app.rt_orders()
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

  -- Para o painel: só id e estado, nunca dados pessoais. Na recusa em massa por
  -- esgotar (D-091) o painel já recebe o aviso do pedido pago; não repete N vezes.
  if new.refusal_reason is distinct from 'vagas_esgotadas' then
    perform app.rt('staff:' || new.banca_id, 'fila', jsonb_build_object(
      'pedido', new.id, 'status', new.status, 'em_atendimento', new.locked_by is not null));
  end if;

  -- D-091: a posição de cada um NÃO é mais avisada pedido a pedido (era 1 aviso por
  -- pessoa da fila a cada mudança, com a banca travada). A página do pedido consulta
  -- a posição no servidor de tempos em tempos.
  return new;
end;
$$;

drop function if exists app.rt_posicoes(uuid, bigint);

-- 2. Fila do painel numa passada (janela + último recado por índice).
create or replace function api.staff_list_queue(p_banca uuid, p_finalizados boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b      app.bancas;
  s      app.banca_stats;
  v_live boolean;
begin
  perform app.require_staff();
  -- Prazos vencidos são aplicados antes de mostrar a fila (o job pode estar atrasado).
  perform app.expire_unanswered();

  select * into b from app.bancas where id = p_banca and status <> 'encerrada';
  if not found then
    raise exception 'banca não encontrada' using errcode = 'P0002';
  end if;
  select * into s from app.banca_stats where banca_id = p_banca;
  select ss.live_mode into v_live from app.staff_sessions ss where ss.session_id = app.current_session_id();

  return jsonb_build_object(
    'live', coalesce(v_live, true),
    'banca', jsonb_build_object(
      'id', b.id, 'nome', b.name, 'codigo', b.code, 'status', b.status, 'vagas', b.slots,
      'pagas', b.paid_count, 'por_pessoa_cents', b.per_person_cents, 'sobra_cents', b.remainder_cents,
      'recebidos', coalesce(s.received, 0), 'recusados', coalesce(s.refused, 0),
      'total_pago_cents', coalesce(s.total_paid_cents, 0)),
    'pedidos', coalesce((
      select jsonb_agg(x.obj order by x.ord)
        from (
          select case when o.status = 'pendente' then o.seq else -extract(epoch from o.updated_at)::bigint end as ord,
                 jsonb_build_object(
                   'id', o.id,
                   'seq', o.seq,
                   'numero', o.numero,
                   'status', o.status,
                   'posicao', o.posicao,
                   'nome_enc', o.full_name_enc,
                   'criado_em', o.created_at,
                   'atendente', case when o.trava_ativa then app.staff_name(o.locked_by) end,
                   'meu', o.trava_ativa and o.locked_by = auth.uid(),
                   'prazo', o.reply_deadline_at,
                   'motivo', o.refusal_reason,
                   'tem_comprovante', o.has_receipt,
                   'ultima_autor', um.author,
                   'ultima_em', um.created_at
                 ) as obj
            -- D-091: posição por janela (uma passada), não uma contagem por pedido.
            from (
              select oo.*,
                     oo.locked_by is not null and oo.lock_activity_at > now() - interval '10 minutes' as trava_ativa,
                     case when oo.status = 'pendente'
                          then row_number() over (partition by oo.status = 'pendente' order by oo.seq) end as posicao
                from app.orders oo
               where oo.banca_id = p_banca
                 and (case when p_finalizados then oo.status <> 'pendente' else oo.status = 'pendente' end)
            ) o
            left join lateral (
              select m.author, m.created_at from app.order_messages m
               where m.order_id = o.id order by m.created_at desc limit 1
            ) um on true
           order by 1
           limit 500
        ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- 3. Inscrição que "girou": a nova tentativa do MESMO navegador recupera o pedido.
-- O navegador manda uma chave aleatória por tentativa (vira o id do pedido). Se o
-- pedido com essa chave já existe, ainda está pendente, é recente e tem o MESMO
-- CPF, o servidor troca o token de acesso e abre o chat dele em vez de responder
-- "CPF repetido". Sem a chave (outro navegador) nada muda.
create function api.srv_reclaim_order(p_id uuid, p_cpf_hmacs bytea[], p_token_hash bytea)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_id is null or octet_length(p_token_hash) <> 32 then
    return false;
  end if;
  update app.orders
     set access_token_hash = p_token_hash
   where id = p_id
     and status = 'pendente'
     and token_revoked_at is null
     and data_erased_at is null
     and cpf_hmac = any(p_cpf_hmacs)
     and created_at > now() - interval '15 minutes';
  if found then
    perform app.audit('pedido_recuperado', null, 'sistema', p_order_id => p_id);
  end if;
  return found;
end;
$$;
revoke all on function api.srv_reclaim_order(uuid, bytea[], bytea) from public, anon, authenticated, service_role;
grant execute on function api.srv_reclaim_order(uuid, bytea[], bytea) to service_role;
