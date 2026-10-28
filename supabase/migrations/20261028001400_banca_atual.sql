-- =====================================================================
-- Tela inicial abre a banca mais recente (DECISIONS D-084, pedido do streamer)
--
-- Devolve SÓ o código da banca criada por último que ainda existe (aberta,
-- pausada ou esgotada). Encerrada não tem código e não entra. Nenhum outro
-- dado sai daqui; quem chama é o servidor (service_role).
-- =====================================================================

create function api.public_current_banca()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select b.code
    from app.bancas b
   where b.code is not null
     and b.status <> 'encerrada'
   order by b.created_at desc, b.id desc
   limit 1
$$;

revoke all on function api.public_current_banca() from public, anon, authenticated;
grant execute on function api.public_current_banca() to service_role;
