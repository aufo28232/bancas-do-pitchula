-- D-088: moderador cria e gerencia bancas; a auditoria grava o papel e o streamer é alertado.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

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
  ('00000000-0000-0000-0000-0000000000e1', 'owner@teste.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'mod@teste.local');
insert into app.staff (user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000e1', 'owner', 'Pitchula'),
  ('00000000-0000-0000-0000-0000000000e2', 'moderator', 'Mod Um');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-00000000008a', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-00000000008b', '00000000-0000-0000-0000-0000000000e2');
insert into app.staff_sessions (session_id, user_id) values
  ('00000000-0000-0000-0000-00000000008a', '00000000-0000-0000-0000-0000000000e1'),
  ('00000000-0000-0000-0000-00000000008b', '00000000-0000-0000-0000-0000000000e2');

create function pg_temp.como(p_uid text, p_session text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_session, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-00000000008b'); end $$;
select is((select per_person_cents from api.owner_create_banca('modbanca-0001', 'Banca do Mod', 30000, 3, false, null, 'Teste', 'https://teste.com/mod')),
  10000::bigint, 'moderador cria banca');
select is(api.owner_update_banca((select id from app.bancas where code = 'modbanca-0001'), 1, 'Banca do Mod', null, null, null, null, 'https://teste.com/outro'),
  2, 'moderador edita o link da banca');
select is(api.owner_set_banca_status((select id from app.bancas where code = 'modbanca-0001'), 'fechar')::text, 'fechada', 'moderador pausa');
reset role;

select is((select actor_role from app.audit_log where action = 'banca_criar'), 'moderator', 'auditoria grava que foi um moderador');
select is((select count(*)::int from app.security_alerts where kind = 'banca_por_moderador'
             and user_id = '00000000-0000-0000-0000-0000000000e1'), 2, 'streamer recebe alerta ao criar e ao trocar o link');

-- Streamer mexendo não gera alerta.
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000008a'); end $$;
select is(api.owner_set_banca_status((select id from app.bancas where code = 'modbanca-0001'), 'reabrir')::text, 'aberta', 'streamer reabre');
reset role;
select is((select count(*)::int from app.security_alerts where kind = 'banca_por_moderador'), 2, 'ação do streamer não gera alerta');

select * from finish();
rollback;
