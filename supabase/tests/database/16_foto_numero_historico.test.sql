-- D-089: foto da banca, pedido sem ID na casa, número por banca e apagar histórico.
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

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
  ('00000000-0000-0000-0000-0000000000f1', 'owner@teste.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'mod@teste.local');
insert into app.staff (user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000f1', 'owner', 'Pitchula'),
  ('00000000-0000-0000-0000-0000000000f2', 'moderator', 'Mod Um');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-00000000009a', '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-00000000009b', '00000000-0000-0000-0000-0000000000f2');
insert into app.staff_sessions (session_id, user_id) values
  ('00000000-0000-0000-0000-00000000009a', '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-00000000009b', '00000000-0000-0000-0000-0000000000f2');

create function pg_temp.h(p text) returns bytea language sql immutable as $$ select sha256(convert_to(p, 'UTF8')) $$;
create function pg_temp.como(p_uid text, p_session text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_session, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- Pedido SEM ID na casa (D-089).
create function pg_temp.pedido(p_code text, p_cpf text) returns text language sql as $$
  select api.public_create_order(
    p_code, gen_random_uuid(),
    'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), null,
    pg_temp.h('cpf:' || p_cpf), pg_temp.h('pix:' || p_cpf), null, pg_temp.h('ip:' || p_cpf),
    1::smallint,
    array[pg_temp.h('cpf:' || p_cpf)], array[pg_temp.h('pix:' || p_cpf)], array[]::bytea[], array[pg_temp.h('ip:' || p_cpf)],
    pg_temp.h('token:' || p_cpf))
$$;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000009a');
  perform api.owner_create_banca('fotoaaaa-0001', 'Banca A', 30000, 3, false, null, 'Teste', 'https://teste.com/a', '1win');
  perform api.owner_create_banca('fotobbbb-0002', 'Banca B', 30000, 3, false, null, 'Teste', 'https://teste.com/b', 'chillbet'); end $$;
select throws_ok($$ select api.owner_create_banca('fotocccc-0003', 'Banca C', 30000, 3, false, null, 'Teste', 'https://teste.com/c', 'outra') $$,
  '23514', null, 'foto fora da lista é recusada');
reset role;

set local role service_role;
select is((select foto from api.public_get_banca('fotoaaaa-0001')), '1win', 'página pública recebe a foto da banca');

-- Pedidos sem ID e numerados por banca.
select is(pg_temp.pedido('fotoaaaa-0001', '1'), 'ok', 'pedido sem ID na casa entra');
select is(pg_temp.pedido('fotoaaaa-0001', '2'), 'ok', 'segundo pedido na banca A');
select is(pg_temp.pedido('fotobbbb-0002', '3'), 'ok', 'primeiro pedido na banca B');
-- D-090: mesma chave Pix com outro CPF, na mesma banca: bloqueado; em outra banca, entra.
select is(api.public_create_order(
    'fotoaaaa-0001', gen_random_uuid(),
    'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), null,
    pg_temp.h('cpf:99'), pg_temp.h('pix:1'), null, pg_temp.h('ip:99'), 1::smallint,
    array[pg_temp.h('cpf:99')], array[pg_temp.h('pix:1')], array[]::bytea[], array[pg_temp.h('ip:99')],
    pg_temp.h('token:99')), 'bloqueado', 'mesmo Pix com outro CPF na mesma banca é bloqueado');
reset role;
select is((select detail ->> 'motivo' from app.audit_log where action = 'pedido_bloqueado' order by id desc limit 1),
  'pix_repetido', 'auditoria registra o motivo pix_repetido');
set local role service_role;
reset role;
select is((select array_agg(numero order by seq) from app.orders o join app.bancas b on b.id = o.banca_id where b.code = 'fotoaaaa-0001'),
  array[1, 2], 'banca A: pedidos #1 e #2');
select is((select numero from app.orders o join app.bancas b on b.id = o.banca_id where b.code = 'fotobbbb-0002'),
  1, 'banca B começa no #1 (número por banca, não global)');
select ok((select platform_id_enc is null and platform_id_hmac is null from app.orders limit 1), 'nenhum ID guardado');

select set_config('teste.pedido', (select o.id::text from app.orders o join app.bancas b on b.id = o.banca_id
                                     where b.code = 'fotoaaaa-0001' and o.numero = 2), true);
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000009b'); end $$;
select is((api.staff_get_order(current_setting('teste.pedido')::uuid)) -> 'pedido' ->> 'numero', '2',
  'painel recebe o número do pedido na banca');

-- Apagar histórico: só streamer, só encerradas.
select throws_ok($$ select api.owner_clear_history() $$, '42501', null, 'moderador NÃO apaga o histórico');
reset role;
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000009a');
  perform api.staff_end_banca((select id from app.bancas where code = 'fotobbbb-0002'), 'Banca B', null); end $$;
select is(api.owner_clear_history(), 1, 'streamer apaga 1 banca encerrada');
reset role;
select is((select count(*)::int from app.bancas), 1, 'a banca aberta continua; a encerrada sumiu');

select * from finish();
rollback;
