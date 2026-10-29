-- D-086: casa de apostas e link de afiliado por banca.
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000d1', 'owner@teste.local');
insert into app.staff (user_id, role, display_name) values ('00000000-0000-0000-0000-0000000000d1', 'owner', 'Pitchula');
insert into auth.sessions (id, user_id) values ('00000000-0000-0000-0000-00000000007a', '00000000-0000-0000-0000-0000000000d1');
insert into app.staff_sessions (session_id, user_id) values ('00000000-0000-0000-0000-00000000007a', '00000000-0000-0000-0000-0000000000d1');

create function pg_temp.como_dono() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d1', 'role', 'authenticated', 'aal', 'aal2',
    'session_id', '00000000-0000-0000-0000-00000000007a', 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

do $$ begin perform pg_temp.como_dono();
  perform api.owner_create_banca('casaaaaa-0001', 'Banca Casa', 30000, 3, false, null, 'Teste', 'https://teste.com/iujdnsajdas'); end $$;
reset role;

set local role service_role;
select is((select platform_name || ' ' || signup_url from api.public_get_banca('casaaaaa-0001')),
  'Teste https://teste.com/iujdnsajdas', 'página pública recebe a casa e o link da banca');
reset role;

do $$ begin perform pg_temp.como_dono(); end $$;
select is((select platform_name from api.staff_list_bancas() where code = 'casaaaaa-0001'), 'Teste', 'painel lista a casa da banca');
select throws_ok($$ select api.owner_create_banca('casaaaaa-0002', 'Banca Http', 30000, 3, false, null, 'Teste', 'http://teste.com/x') $$,
  '23514', null, 'link sem https é recusado pelo banco');
select throws_ok($$ select api.owner_create_banca('casaaaaa-0003', 'Banca Js', 30000, 3, false, null, 'Teste', 'javascript:alert(1)') $$,
  '23514', null, 'link que não é https é recusado pelo banco');

-- Sem pedido: troca casa e link.
select is(api.owner_update_banca((select id from app.bancas where code = 'casaaaaa-0001'), 1, 'Banca Casa', null, null, null,
  'Outra', 'https://outra.bet/abc'), 2, 'sem pedido, troca casa e link');
reset role;
select is((select platform_name || ' ' || signup_url from app.bancas where code = 'casaaaaa-0001'),
  'Outra https://outra.bet/abc', 'casa e link trocados');

-- Com pedido: casa trava, link continua livre.
update app.bancas set order_count = 1 where code = 'casaaaaa-0001';
do $$ begin perform pg_temp.como_dono(); end $$;
select throws_ok($$ select api.owner_update_banca((select id from app.bancas where code = 'casaaaaa-0001'), 2, 'Banca Casa', null, null, null, 'Terceira', null) $$,
  '55000', null, 'com pedido, a casa fica travada');
select is(api.owner_update_banca((select id from app.bancas where code = 'casaaaaa-0001'), 2, 'Banca Casa', null, null, null,
  'Outra', 'https://outra.bet/novo'), 3, 'com pedido, o link ainda muda (mesma casa)');
reset role;

-- Banca antiga (sem casa): continua valendo, a página usa o padrão do ambiente.
insert into app.bancas (code, code_hash, name, total_cents, slots, ip_limit, created_by)
values ('antigaaa-0009', sha256('antigaaa-0009'::bytea), 'Banca Antiga', 3000, 3, false, '00000000-0000-0000-0000-0000000000d1');
set local role service_role;
select is((select platform_name from api.public_get_banca('antigaaa-0009')), null, 'banca antiga sem casa: o site usa o padrão');
reset role;

select * from finish();
rollback;
