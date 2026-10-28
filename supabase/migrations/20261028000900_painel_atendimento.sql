-- =====================================================================
-- Etapa 5 · Painel de atendimento
-- ARCHITECTURE §5.6, §5.8, §5.9 · DECISIONS D-004, D-014, D-015, D-016,
-- D-033, D-043
--
-- Todas as funções exigem staff AAL2 com sessão viva (app.require_staff) e
-- travam as linhas na ordem BANCA -> PEDIDO (evita deadlock). Os dados
-- pessoais saem daqui CIFRADOS: quem decifra (e mascara no modo live) é o
-- servidor, que tem a chave.
--
-- Códigos de erro próprios (o servidor traduz para mensagens):
--   BP001 pedido com outro moderador     BP002 pedido não está pendente
--   BP003 sem vaga                        BP004 precisa assumir antes
--   BP005 dado inválido para a operação
-- =====================================================================

-- Trava viva = alguém mexeu no pedido nos últimos 10 min (D-016).
create function app.lock_active(o app.orders)
returns boolean
language sql
stable
set search_path = ''
as $$
  select o.locked_by is not null and o.lock_activity_at > now() - interval '10 minutes'
$$;

create function app.staff_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select display_name from app.staff where user_id = p_user
$$;

-- ---------------------------------------------------------------------
-- Leitura: fila da banca
-- ---------------------------------------------------------------------
create function api.staff_list_queue(p_banca uuid, p_finalizados boolean default false)
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
                   'status', o.status,
                   'posicao', case when o.status = 'pendente'
                                   then (select count(*) + 1 from app.orders p
                                          where p.banca_id = o.banca_id and p.status = 'pendente' and p.seq < o.seq) end,
                   'nome_enc', o.full_name_enc,
                   'criado_em', o.created_at,
                   'atendente', case when app.lock_active(o) then app.staff_name(o.locked_by) end,
                   'meu', app.lock_active(o) and o.locked_by = auth.uid(),
                   'prazo', o.reply_deadline_at,
                   'motivo', o.refusal_reason,
                   'tem_comprovante', o.has_receipt,
                   'ultima_autor', (select m.author from app.order_messages m where m.order_id = o.id
                                     order by m.created_at desc limit 1),
                   'ultima_em', (select max(m.created_at) from app.order_messages m where m.order_id = o.id)
                 ) as obj
            from app.orders o
           where o.banca_id = p_banca
             and (case when p_finalizados then o.status <> 'pendente' else o.status = 'pendente' end)
           order by 1
           limit 500
        ) x
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------
-- Leitura: um pedido com o chat
-- ---------------------------------------------------------------------
create function api.staff_get_order(p_order uuid)
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
      'tem_comprovante', o.has_receipt, 'pix_tipo', o.pix_type,
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
                                    'tem_anexo', mm.attachment_id is not null,
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

-- Trava o pedido (e antes a banca) para uma ação. Aplica a expiração do prazo antes.
create function app.order_for_action(p_order uuid)
returns app.orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_banca uuid;
  o       app.orders;
begin
  select banca_id into v_banca from app.orders where id = p_order;
  if v_banca is null then
    raise exception 'pedido não encontrado' using errcode = 'P0002';
  end if;
  perform 1 from app.bancas where id = v_banca for update;
  perform app.expire_order_if_due(p_order);
  select * into o from app.orders where id = p_order for update;
  return o;
end;
$$;

-- ---------------------------------------------------------------------
-- Assumir, forçar e liberar
-- ---------------------------------------------------------------------
create function api.staff_claim(p_order uuid, p_idem uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  v_prev jsonb := app.idem_get(auth.uid(), p_idem, 'assumir', p_order);
  o      app.orders;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  o := app.order_for_action(p_order);
  if o.status <> 'pendente' then
    raise exception 'pedido finalizado' using errcode = 'BP002';
  end if;
  if app.lock_active(o) and o.locked_by <> auth.uid() then
    raise exception 'pedido com outro moderador' using errcode = 'BP001';
  end if;

  update app.orders
     set locked_by = auth.uid(),
         locked_at = case when locked_by = auth.uid() and app.lock_active(o) then locked_at else now() end,
         lock_activity_at = now(),
         -- Trava expirada de outra pessoa: o prazo dela não vale para quem assume agora.
         reply_deadline_at = case when locked_by = auth.uid() then reply_deadline_at end
   where id = p_order;
  update app.bancas set last_activity_at = now() where id = o.banca_id;

  perform app.audit('assumir', auth.uid(), v_role::text, p_banca_id => o.banca_id, p_order_id => p_order);
  perform app.idem_put(auth.uid(), p_idem, 'assumir', p_order, '{"resultado": "ok"}'::jsonb);
  return '{"resultado": "ok"}'::jsonb;
end;
$$;

create function api.owner_force_claim(p_order uuid, p_idem uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev jsonb;
  o      app.orders;
begin
  perform app.require_owner();
  v_prev := app.idem_get(auth.uid(), p_idem, 'forcar_assumir', p_order);
  if v_prev is not null then
    return v_prev;
  end if;
  o := app.order_for_action(p_order);
  if o.status <> 'pendente' then
    raise exception 'pedido finalizado' using errcode = 'BP002';
  end if;

  update app.orders
     set locked_by = auth.uid(), locked_at = now(), lock_activity_at = now(), reply_deadline_at = null
   where id = p_order;

  perform app.audit('forcar_assumir', auth.uid(), 'owner', p_banca_id => o.banca_id, p_order_id => p_order,
                    p_target => o.locked_by,
                    p_detail => jsonb_build_object('moderador_anterior', coalesce(app.staff_name(o.locked_by), '')));
  perform app.idem_put(auth.uid(), p_idem, 'forcar_assumir', p_order, '{"resultado": "ok"}'::jsonb);
  return '{"resultado": "ok"}'::jsonb;
end;
$$;

create function api.staff_release(p_order uuid, p_idem uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  v_prev jsonb := app.idem_get(auth.uid(), p_idem, 'liberar', p_order);
  o      app.orders;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  o := app.order_for_action(p_order);
  if o.status <> 'pendente' then
    raise exception 'pedido finalizado' using errcode = 'BP002';
  end if;
  if o.locked_by is distinct from auth.uid() and v_role <> 'owner' then
    raise exception 'pedido com outro moderador' using errcode = 'BP001';
  end if;

  update app.orders
     set locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
   where id = p_order;

  perform app.audit('liberar', auth.uid(), v_role::text, p_banca_id => o.banca_id, p_order_id => p_order);
  perform app.idem_put(auth.uid(), p_idem, 'liberar', p_order, '{"resultado": "ok"}'::jsonb);
  return '{"resultado": "ok"}'::jsonb;
end;
$$;

-- Confere a trava para ações de atendimento: precisa ser do próprio moderador
-- e estar viva. Renova a atividade (D-016).
create function app.require_own_lock(o app.orders)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if o.status <> 'pendente' then
    raise exception 'pedido finalizado' using errcode = 'BP002';
  end if;
  if not (app.lock_active(o) and o.locked_by = auth.uid()) then
    if app.lock_active(o) then
      raise exception 'pedido com outro moderador' using errcode = 'BP001';
    end if;
    raise exception 'assuma o pedido antes' using errcode = 'BP004';
  end if;
  update app.orders set lock_activity_at = now() where id = o.id;
end;
$$;

-- ---------------------------------------------------------------------
-- Chat do moderador: inicia (ou reinicia) o prazo de 5 min (D-043)
-- ---------------------------------------------------------------------
create function api.staff_send_message(p_order uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  o      app.orders;
  v_id   uuid;
begin
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 1000 then
    raise exception 'mensagem inválida' using errcode = 'BP005';
  end if;
  o := app.order_for_action(p_order);
  perform app.require_own_lock(o);

  insert into app.order_messages (order_id, author, staff_id, body)
  values (p_order, 'staff', auth.uid(), btrim(p_body))
  returning id into v_id;
  update app.orders set reply_deadline_at = now() + interval '5 minutes' where id = p_order;
  update app.bancas set last_activity_at = now() where id = o.banca_id;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Marcar pago (D-004, D-033). Sem "desfazer".
-- ---------------------------------------------------------------------
create function api.staff_mark_paid(p_order uuid, p_idem uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role  app.staff_role := app.require_staff();
  v_prev  jsonb := app.idem_get(auth.uid(), p_idem, 'pagar', p_order);
  o       app.orders;
  b       app.bancas;
  v_recus integer := 0;
  v_res   jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  o := app.order_for_action(p_order);   -- banca já travada aqui (FOR UPDATE)
  if v_role = 'owner' and o.status = 'pendente' and not (app.lock_active(o) and o.locked_by <> auth.uid()) then
    null; -- streamer pode pagar sem assumir, desde que ninguém esteja com o pedido
  else
    perform app.require_own_lock(o);
  end if;

  select * into b from app.bancas where id = o.banca_id;
  if b.paid_count >= b.slots then
    raise exception 'sem vaga' using errcode = 'BP003';
  end if;

  update app.orders
     set status = 'pago', paid_by = auth.uid(), paid_at = now(),
         locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
   where id = p_order;
  update app.bancas set paid_count = paid_count + 1, last_activity_at = now() where id = b.id;
  update app.banca_stats
     set paid = paid + 1, total_paid_cents = total_paid_cents + b.per_person_cents
   where banca_id = b.id;
  insert into app.order_messages (order_id, author, body)
  values (p_order, 'sistema', 'Pagamento registrado pela equipe.');

  perform app.audit('pagar', auth.uid(), v_role::text, p_banca_id => b.id, p_order_id => p_order,
                    p_detail => jsonb_build_object('valor_cents', b.per_person_cents));

  -- Última vaga: a banca esgota e os demais pendentes são recusados na hora (D-004).
  if b.paid_count + 1 = b.slots then
    update app.bancas set status = 'esgotada', sold_out_at = now() where id = b.id;
    with recusados as (
      update app.orders
         set status = 'recusado', refused_at = now(), refused_by = null, refusal_reason = 'vagas_esgotadas',
             locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
       where banca_id = b.id and status = 'pendente'
      returning id
    ), msgs as (
      insert into app.order_messages (order_id, author, body)
      select id, 'sistema', 'As vagas desta banca acabaram e o pedido foi encerrado.' from recusados
      returning 1
    )
    select count(*) into v_recus from msgs;
    update app.banca_stats set refused = refused + v_recus where banca_id = b.id;
    perform app.audit('banca_esgotada', null, 'sistema', p_banca_id => b.id,
                      p_detail => jsonb_build_object('recusados', v_recus));
  end if;

  v_res := jsonb_build_object('resultado', 'ok', 'esgotou', b.paid_count + 1 = b.slots, 'recusados', v_recus);
  perform app.idem_put(auth.uid(), p_idem, 'pagar', p_order, v_res);
  return v_res;
end;
$$;

-- ---------------------------------------------------------------------
-- Recusar (motivos que um moderador pode escolher)
-- ---------------------------------------------------------------------
create function api.staff_refuse(p_order uuid, p_reason text, p_note text, p_idem uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  v_prev jsonb := app.idem_get(auth.uid(), p_idem, 'recusar', p_order);
  o      app.orders;
  v_nota text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if p_reason is null or p_reason not in ('comprovante_ilegivel', 'deposito_nao_encontrado', 'dados_divergentes', 'outro') then
    raise exception 'motivo inválido' using errcode = 'BP005';
  end if;
  if v_nota is not null and char_length(v_nota) > 280 then
    raise exception 'nota longa demais' using errcode = 'BP005';
  end if;
  o := app.order_for_action(p_order);
  if v_role = 'owner' and o.status = 'pendente' and not (app.lock_active(o) and o.locked_by <> auth.uid()) then
    null;
  else
    perform app.require_own_lock(o);
  end if;

  update app.orders
     set status = 'recusado', refused_by = auth.uid(), refused_at = now(),
         refusal_reason = p_reason::app.refusal_reason, refusal_note = v_nota,
         locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
   where id = p_order;
  update app.banca_stats set refused = refused + 1 where banca_id = o.banca_id;
  update app.bancas set last_activity_at = now() where id = o.banca_id;

  perform app.audit('recusar', auth.uid(), v_role::text, p_banca_id => o.banca_id, p_order_id => p_order,
                    p_detail => jsonb_build_object('motivo', p_reason));
  perform app.idem_put(auth.uid(), p_idem, 'recusar', p_order, '{"resultado": "ok"}'::jsonb);
  return '{"resultado": "ok"}'::jsonb;
end;
$$;

-- ---------------------------------------------------------------------
-- Banimento a partir de um pedido (o moderador nunca digita o dado, §5.9)
-- ---------------------------------------------------------------------
create function api.staff_ban(
  p_order         uuid,
  p_kind          text,
  p_scope         text,
  p_reason        text,
  p_expires_hours integer,
  p_idem          uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role   app.staff_role := app.require_staff();
  v_prev   jsonb := app.idem_get(auth.uid(), p_idem, 'banir', p_order);
  o        app.orders;
  v_hmac   bytea;
  v_ban    uuid;
  v_expira timestamptz;
  v_res    jsonb;
begin
  if v_prev is not null then
    return v_prev;
  end if;
  if p_kind is null or p_kind not in ('cpf', 'pix', 'platform_id', 'ip')
     or p_scope is null or p_scope not in ('global', 'banca')
     or p_reason is null or char_length(btrim(p_reason)) not between 3 and 280 then
    raise exception 'dados do banimento inválidos' using errcode = 'BP005';
  end if;
  if p_kind = 'ip' and (p_expires_hours is null or p_expires_hours not between 1 and 168) then
    raise exception 'banimento de IP precisa de validade de até 7 dias' using errcode = 'BP005';
  end if;
  if p_kind <> 'ip' and p_expires_hours is not null and p_expires_hours not between 1 and 8760 then
    raise exception 'validade inválida' using errcode = 'BP005';
  end if;

  o := app.order_for_action(p_order);
  v_hmac := case p_kind
              when 'cpf' then o.cpf_hmac
              when 'pix' then o.pix_hmac
              when 'platform_id' then o.platform_id_hmac
              else o.ip_hmac end;
  v_expira := case when p_expires_hours is null then null else now() + make_interval(hours => p_expires_hours) end;

  -- Já existe um ban ativo igual? Não duplica.
  select x.id into v_ban from app.bans x
   where x.kind = p_kind::app.ban_kind and x.value_hmac = v_hmac and x.lifted_at is null
     and x.scope = p_scope::app.ban_scope and (p_scope = 'global' or x.banca_id = o.banca_id)
     and (x.expires_at is null or x.expires_at > now())
   limit 1;

  if v_ban is null then
    insert into app.bans (kind, value_hmac, hmac_key_version, scope, banca_id, reason, source_order_id,
                          created_by, expires_at, review_due_at)
    values (p_kind::app.ban_kind, v_hmac, o.hmac_key_version, p_scope::app.ban_scope,
            case when p_scope = 'banca' then o.banca_id end, btrim(p_reason), o.id, auth.uid(), v_expira,
            case when p_kind = 'ip' then null else now() + interval '12 months' end)
    returning id into v_ban;
  end if;

  -- Pedido de origem pendente: recusado e link revogado (o espectador perde o acesso).
  if o.status = 'pendente' then
    update app.orders
       set status = 'recusado', refused_by = auth.uid(), refused_at = now(), refusal_reason = 'banido',
           locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null,
           token_revoked_at = now()
     where id = o.id;
    delete from app.order_sessions where order_id = o.id;
    update app.banca_stats set refused = refused + 1 where banca_id = o.banca_id;
  end if;

  perform app.audit('banir', auth.uid(), v_role::text, p_banca_id => o.banca_id, p_order_id => o.id,
                    p_detail => jsonb_build_object('tipo', p_kind, 'escopo', p_scope, 'expira_em', v_expira));
  v_res := jsonb_build_object('resultado', 'ok', 'ban', v_ban);
  perform app.idem_put(auth.uid(), p_idem, 'banir', p_order, v_res);
  return v_res;
end;
$$;

create function api.staff_list_bans()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', x.id, 'tipo', x.kind, 'escopo', x.scope,
             'banca', (select name from app.bancas where id = x.banca_id),
             'motivo', x.reason, 'autor', app.staff_name(x.created_by), 'criado_em', x.created_at,
             'expira_em', x.expires_at, 'revisao_em', x.review_due_at,
             'revisao_vencida', x.review_due_at is not null and x.review_due_at < now(),
             'pode_desbanir', v_role = 'owner' or (x.created_by = auth.uid() and x.scope = 'banca'))
           order by x.created_at desc)
      from app.bans x
     where x.lifted_at is null
       and (x.expires_at is null or x.expires_at > now())
  ), '[]'::jsonb);
end;
$$;

-- D-014: o streamer desbane qualquer um; o moderador só os bans DA BANCA que ele criou.
create function api.staff_lift_ban(p_ban uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  x      app.bans;
begin
  select * into x from app.bans where id = p_ban and lifted_at is null for update;
  if not found then
    raise exception 'banimento não encontrado' using errcode = 'P0002';
  end if;
  if v_role <> 'owner' and not (x.created_by = auth.uid() and x.scope = 'banca') then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
  update app.bans set lifted_at = now(), lifted_by = auth.uid() where id = p_ban;
  perform app.audit('desbanir', auth.uid(), v_role::text, p_banca_id => x.banca_id,
                    p_detail => jsonb_build_object('tipo', x.kind::text, 'escopo', x.scope::text));
end;
$$;

-- ---------------------------------------------------------------------
-- Modo live: revelar um dado / copiar Pix (auditados) e ligar/desligar
-- ---------------------------------------------------------------------
create function api.staff_reveal(p_order uuid, p_campo text, p_acao text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  o      app.orders;
begin
  if p_campo not in ('nome', 'cpf', 'pix', 'pid') or p_acao not in ('revelar', 'copiar_pix')
     or (p_acao = 'copiar_pix' and p_campo <> 'pix') then
    raise exception 'campo inválido' using errcode = 'BP005';
  end if;
  select * into o from app.orders where id = p_order;
  if not found then
    raise exception 'pedido não encontrado' using errcode = 'P0002';
  end if;
  -- Revelar e copiar contam como atividade da trava de quem está com o pedido (D-016).
  if app.lock_active(o) and o.locked_by = auth.uid() then
    update app.orders set lock_activity_at = now() where id = o.id;
  end if;
  perform app.audit(p_acao, auth.uid(), v_role::text, p_banca_id => o.banca_id, p_order_id => o.id,
                    p_detail => jsonb_build_object('campo', p_campo));
  return case p_campo
           when 'nome' then o.full_name_enc
           when 'cpf' then o.cpf_enc
           when 'pix' then o.pix_key_enc
           else o.platform_id_enc end;
end;
$$;

create function api.staff_set_live_mode(p_ligado boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
begin
  update app.staff_sessions set live_mode = p_ligado where session_id = app.current_session_id();
  perform app.audit(case when p_ligado then 'modo_live_on' else 'modo_live_off' end, auth.uid(), v_role::text);
  return p_ligado;
end;
$$;

-- ---------------------------------------------------------------------
-- Respostas rápidas: todos usam, só o streamer edita
-- ---------------------------------------------------------------------
create function api.staff_list_quick_replies()
returns table (id uuid, label text, body text, sort integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform app.require_staff();
  return query select q.id, q.label, q.body, q.sort from app.quick_replies q where q.active order by q.sort, q.created_at;
end;
$$;

create function api.owner_save_quick_reply(p_id uuid, p_label text, p_body text, p_sort integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform app.require_owner();
  if p_id is null then
    insert into app.quick_replies (label, body, sort, created_by)
    values (btrim(p_label), btrim(p_body), coalesce(p_sort, 100), auth.uid())
    returning id into v_id;
  else
    update app.quick_replies
       set label = btrim(p_label), body = btrim(p_body), sort = coalesce(p_sort, sort)
     where id = p_id and active
    returning id into v_id;
    if v_id is null then
      raise exception 'resposta não encontrada' using errcode = 'P0002';
    end if;
  end if;
  perform app.audit('resposta_rapida', auth.uid(), 'owner', p_detail => '{"resultado": "salva"}'::jsonb);
  return v_id;
end;
$$;

create function api.owner_delete_quick_reply(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.require_owner();
  update app.quick_replies set active = false where id = p_id and active;
  if not found then
    raise exception 'resposta não encontrada' using errcode = 'P0002';
  end if;
  perform app.audit('resposta_rapida', auth.uid(), 'owner', p_detail => '{"resultado": "removida"}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------
revoke all on function
  app.lock_active(app.orders), app.staff_name(uuid), app.order_for_action(uuid), app.require_own_lock(app.orders),
  api.staff_list_queue(uuid, boolean), api.staff_get_order(uuid),
  api.staff_claim(uuid, uuid), api.owner_force_claim(uuid, uuid), api.staff_release(uuid, uuid),
  api.staff_send_message(uuid, text), api.staff_mark_paid(uuid, uuid), api.staff_refuse(uuid, text, text, uuid),
  api.staff_ban(uuid, text, text, text, integer, uuid), api.staff_list_bans(), api.staff_lift_ban(uuid),
  api.staff_reveal(uuid, text, text), api.staff_set_live_mode(boolean),
  api.staff_list_quick_replies(), api.owner_save_quick_reply(uuid, text, text, integer), api.owner_delete_quick_reply(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  api.staff_list_queue(uuid, boolean), api.staff_get_order(uuid),
  api.staff_claim(uuid, uuid), api.owner_force_claim(uuid, uuid), api.staff_release(uuid, uuid),
  api.staff_send_message(uuid, text), api.staff_mark_paid(uuid, uuid), api.staff_refuse(uuid, text, text, uuid),
  api.staff_ban(uuid, text, text, text, integer, uuid), api.staff_list_bans(), api.staff_lift_ban(uuid),
  api.staff_reveal(uuid, text, text), api.staff_set_live_mode(boolean),
  api.staff_list_quick_replies(), api.owner_save_quick_reply(uuid, text, text, integer), api.owner_delete_quick_reply(uuid)
to authenticated;
