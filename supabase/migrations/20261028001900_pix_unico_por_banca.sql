-- =====================================================================
-- Mesma chave Pix não entra duas vezes na mesma banca (DECISIONS D-090,
-- pedido do streamer), mesmo com CPF diferente. Mesma regra do CPF: vale
-- contra qualquer pedido da banca (pendente, pago ou recusado) e responde a
-- mensagem genérica de sempre, sem dizer qual dado repetiu.
-- =====================================================================

create or replace function api.public_create_order(
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
  -- Mesma chave Pix na mesma banca, mesmo com outro CPF (D-090). A linha da banca
  -- está travada (for update): dois envios simultâneos não passam juntos.
  elsif exists (select 1 from app.orders o where o.banca_id = b.id and o.pix_hmac = any(p_pix_hmacs)) then
    v_motivo := 'pix_repetido';
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

  -- Teto de pendentes só se a banca tiver um (D-032 revista: padrão = sem teto).
  if b.pending_factor is not null then
    select count(*) into v_pend from app.orders o where o.banca_id = b.id and o.status = 'pendente';
    if v_pend >= b.pending_factor * (b.slots - b.paid_count) then
      return 'fila_cheia';
    end if;
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
