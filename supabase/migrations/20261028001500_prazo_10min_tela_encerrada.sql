-- =====================================================================
-- Pedido do streamer (DECISIONS D-085):
--  1. Prazo para o espectador responder passa de 5 para 10 minutos.
--  2. Tela inicial: por 30 min depois de uma banca ser encerrada, mostra
--     "Bancas encerradas, até a próxima" em vez de "Aguardando banca...".
-- =====================================================================

-- 1. Mesma função de D-043, só o intervalo muda.
create or replace function api.staff_send_message(p_order uuid, p_body text)
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
  update app.orders set reply_deadline_at = now() + interval '10 minutes' where id = p_order;
  update app.bancas set last_activity_at = now() where id = o.banca_id;
  return v_id;
end;
$$;

-- 2. Estado da tela inicial numa chamada só (substitui public_current_banca, D-084).
--    {"codigo": "<banca mais recente que ainda existe>" | null,
--     "encerrada": true se não há banca e alguma foi encerrada há menos de 30 min}
drop function if exists api.public_current_banca();

create function api.public_home()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with atual as (
    select b.code
      from app.bancas b
     where b.code is not null
       and b.status <> 'encerrada'
     order by b.created_at desc, b.id desc
     limit 1
  )
  select jsonb_build_object(
    'codigo', (select code from atual),
    'encerrada', not exists (select 1 from atual)
                 and exists (select 1 from app.bancas b
                              where b.status = 'encerrada'
                                and b.ended_at > now() - interval '30 minutes')
  )
$$;

revoke all on function api.public_home() from public, anon, authenticated;
grant execute on function api.public_home() to service_role;
