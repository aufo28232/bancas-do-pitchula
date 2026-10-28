-- =====================================================================
-- Etapa 7 · Endurecimento
-- - alerta para o streamer quando um moderador encerra uma banca (T22);
-- - sinais de fraude no detalhe do pedido (T9);
-- - auditoria legível pelo streamer, com verificação da cadeia de hash (D-019).
-- =====================================================================

create or replace function app.end_banca(p_banca uuid, p_actor uuid, p_role text, p_motivo text)
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
  -- Moderador encerrou: o streamer recebe um alerta no painel (T22).
  if p_role = 'moderator' then
    insert into app.security_alerts (user_id, kind)
    select user_id, 'encerramento_por_moderador' from app.staff where role = 'owner' and active;
  end if;
  return v_res;
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

-- ---------------------------------------------------------------------
-- Auditoria para o streamer (só leitura; ninguém altera)
-- ---------------------------------------------------------------------
create function api.owner_list_audit(p_limit integer, p_antes bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_owner();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'pos', a.chain_pos, 'em', a.at, 'acao', a.action, 'papel', a.actor_role,
             'autor', app.staff_name(a.actor_id),
             'alvo', app.staff_name(a.target_user_id),
             'banca', (select b.name from app.bancas b where b.id = a.banca_id),
             'pedido', left(a.order_id::text, 8),
             'detalhe', a.detail)
           order by a.chain_pos desc)
      from (select * from app.audit_log
             where p_antes is null or chain_pos < p_antes
             order by chain_pos desc
             limit greatest(1, least(coalesce(p_limit, 100), 500))) a
  ), '[]'::jsonb);
end;
$$;

create function api.owner_verify_audit()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_quebra bigint;
begin
  perform app.require_owner();
  v_quebra := app.audit_verify();
  return jsonb_build_object(
    'integra', v_quebra is null,
    'quebra_em', v_quebra,
    'registros', (select count(*) from app.audit_log),
    'ancora', (select last_purged_pos from app.audit_anchor where id = 1));
end;
$$;

revoke all on function api.owner_list_audit(integer, bigint), api.owner_verify_audit()
from public, anon, authenticated, service_role;
grant execute on function api.owner_list_audit(integer, bigint), api.owner_verify_audit() to authenticated;
