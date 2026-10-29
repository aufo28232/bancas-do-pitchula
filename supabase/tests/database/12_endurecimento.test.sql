-- Etapa 7: alerta de encerramento por moderador, sinais de fraude e auditoria para o streamer.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

set local app.audit_purge = 'on';
delete from app.audit_log;
delete from app.audit_anchor;
delete from app.security_alerts;
delete from app.staff_sessions;
delete from app.known_devices;
delete from app.staff_invites;
delete from app.order_messages;
delete from app.order_attachments;
delete from app.order_sessions;
delete from app.orders;
delete from app.bans;
delete from app.banca_stats;
delete from app.bancas;
delete from app.idempotency_keys;
update app.quick_replies set created_by = null;
delete from app.staff;
set local app.audit_purge = 'off';

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod@teste.local');
insert into app.staff (user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', 'Pitchula'),
  ('00000000-0000-0000-0000-0000000000a2', 'moderator', 'Mod Um');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2');
insert into app.staff_sessions (session_id, user_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2');

create function pg_temp.h(p text) returns bytea language sql immutable as $$ select sha256(convert_to(p, 'UTF8')) $$;
create function pg_temp.como(p_uid text, p_session text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_session, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- Pedido com CPF próprio, mas Pix e ID escolhidos (para os sinais de fraude).
create function pg_temp.pedido(p_id uuid, p_code text, p_cpf text, p_pix text, p_pid text) returns text language sql as $$
  select api.public_create_order(
    p_code, p_id,
    'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), 'v1:' || repeat('D', 32),
    pg_temp.h('cpf:' || p_cpf), pg_temp.h('pix:' || p_pix), pg_temp.h('pid:' || p_pid), pg_temp.h('ip:' || p_cpf),
    1::smallint,
    array[pg_temp.h('cpf:' || p_cpf)], array[pg_temp.h('pix:' || p_pix)],
    array[pg_temp.h('pid:' || p_pid)], array[pg_temp.h('ip:' || p_cpf)],
    pg_temp.h('token:' || p_cpf))
$$;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a');
  perform api.owner_create_banca('sinaisaa-0001', 'Banca Sinais', 30000, 3, false, null); end $$;
reset role;
set local role service_role;
do $$ begin
  perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b1', 'sinaisaa-0001', '1', 'mesmo-pix', 'id-1');
  perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b2', 'sinaisaa-0001', '2', 'pix-do-b2', 'id-1');
  perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b3', 'sinaisaa-0001', '3', 'outro-pix', 'id-3'); end $$;
reset role;
-- Pix repetido na mesma banca não entra mais (D-090); simula um pedido antigo com o mesmo Pix.
update app.orders set pix_hmac = (select pix_hmac from app.orders where id = '00000000-0000-0000-0000-0000000000b1')
 where id = '00000000-0000-0000-0000-0000000000b2';
insert into app.order_attachments (order_id, storage_path, bytes, width, height, sha256) values
  ('00000000-0000-0000-0000-0000000000b1', 'comprovantes/' || gen_random_uuid() || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.webp', 10, 1, 1, pg_temp.h('print')),
  ('00000000-0000-0000-0000-0000000000b3', 'comprovantes/' || gen_random_uuid() || '/' || gen_random_uuid() || '/' || gen_random_uuid() || '.webp', 10, 1, 1, pg_temp.h('print'));

-- 1. Sinais de fraude ---------------------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b'); end $$;
select is(api.staff_get_order('00000000-0000-0000-0000-0000000000b1') -> 'sinais' ->> 'mesmo_pix', '1', 'mesmo Pix em outro pedido da banca');
select is(api.staff_get_order('00000000-0000-0000-0000-0000000000b1') -> 'sinais' ->> 'mesmo_id', '1', 'mesmo ID em outro pedido da banca');
select is(api.staff_get_order('00000000-0000-0000-0000-0000000000b1') -> 'sinais' ->> 'comprovante_repetido', '1',
  'o mesmo comprovante (sha256) aparece em outro pedido');
select is(api.staff_get_order('00000000-0000-0000-0000-0000000000b2') -> 'sinais' ->> 'comprovante_repetido', '0', 'pedido sem comprovante repetido');

-- 1b. Exclusão a pedido feita pela equipe -------------------------------------------
select is(api.staff_erase_order('00000000-0000-0000-0000-0000000000b2') ->> 'resultado', 'ok', 'moderador apaga os dados a pedido do titular');
reset role;
select is((select status::text || '/' || refusal_reason::text from app.orders where id = '00000000-0000-0000-0000-0000000000b2'),
  'recusado/exclusao_a_pedido', 'pedido pendente vira recusado por exclusão a pedido');
select ok((select cpf_enc like 'v0:%' and data_erased_at is not null from app.orders where id = '00000000-0000-0000-0000-0000000000b2'),
  'dados pessoais substituídos por valores que não decifram');
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b'); end $$;

-- 2. Auditoria só para o streamer ---------------------------------------------------
select throws_ok($$ select api.owner_list_audit(50, null) $$, '42501', null, 'moderador NÃO lê a auditoria');

-- 3. Moderador encerra: o streamer recebe alerta (T22) --------------------------------
select ok((api.staff_end_banca((select id from app.bancas where name = 'Banca Sinais'), 'Banca Sinais', null) ->> 'recebidos') = '3',
  'moderador encerra a banca');
reset role;
select ok(exists (select 1 from app.security_alerts where kind = 'encerramento_por_moderador'
                   and user_id = '00000000-0000-0000-0000-0000000000a1'), 'streamer recebe alerta de encerramento por moderador');

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a'); end $$;
select ok(exists (select 1 from jsonb_array_elements(api.owner_list_audit(50, null)) e
                   where e ->> 'acao' = 'banca_encerrar' and e ->> 'autor' = 'Mod Um'),
  'streamer lê na auditoria quem encerrou');
select is(api.owner_verify_audit() ->> 'integra', 'true', 'cadeia de hash da auditoria íntegra');
reset role;

select * from finish();
rollback;
