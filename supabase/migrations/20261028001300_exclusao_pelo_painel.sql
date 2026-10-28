-- =====================================================================
-- Exclusão a pedido do titular feita pela EQUIPE (o botão do espectador saiu
-- a pedido do streamer). O espectador pede pelo chat; o moderador apaga.
-- Mesmo efeito de D-018/D-076: pendente vira recusado ("exclusão a pedido") e
-- os dados pessoais, o chat e os comprovantes são apagados na hora.
-- =====================================================================
create function api.staff_erase_order(p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role app.staff_role := app.require_staff();
  o      app.orders;
begin
  o := app.order_for_action(p_order);
  if o.data_erased_at is not null then
    return '{"resultado": "ok"}'::jsonb;
  end if;
  if o.status = 'pendente' then
    update app.orders
       set status = 'recusado', refused_at = now(), refused_by = auth.uid(), refusal_reason = 'exclusao_a_pedido',
           locked_by = null, locked_at = null, lock_activity_at = null, reply_deadline_at = null
     where id = p_order;
    update app.banca_stats set refused = refused + 1 where banca_id = o.banca_id;
  end if;
  perform app.erase_order_personal(p_order);
  perform app.audit('exclusao_dados', auth.uid(), v_role::text, p_banca_id => o.banca_id, p_order_id => p_order,
                    p_detail => jsonb_build_object('de', o.status::text));
  return '{"resultado": "ok"}'::jsonb;
end;
$$;

revoke all on function api.staff_erase_order(uuid) from public, anon, authenticated, service_role;
grant execute on function api.staff_erase_order(uuid) to authenticated;
