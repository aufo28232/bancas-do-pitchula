-- D-084/D-085: a tela inicial abre a banca criada por último que ainda existe;
-- sem banca, mostra "Bancas encerradas" por 30 min depois de um encerramento.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

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

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'owner@teste.local');
insert into app.staff (user_id, role, display_name) values ('00000000-0000-0000-0000-0000000000c1', 'owner', 'Pitchula');
insert into auth.sessions (id, user_id) values ('00000000-0000-0000-0000-00000000006a', '00000000-0000-0000-0000-0000000000c1');
insert into app.staff_sessions (session_id, user_id) values ('00000000-0000-0000-0000-00000000006a', '00000000-0000-0000-0000-0000000000c1');

create function pg_temp.como_dono() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000c1', 'role', 'authenticated', 'aal', 'aal2',
    'session_id', '00000000-0000-0000-0000-00000000006a', 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Sem banca nenhuma: "Aguardando banca...".
set local role service_role;
select is(api.public_home(), '{"codigo": null, "encerrada": false}'::jsonb, 'sem banca: aguardando');
reset role;

do $$ begin perform pg_temp.como_dono();
  perform api.owner_create_banca('antigaaa-0001', 'Banca Antiga', 30000, 3, false, null); end $$;
reset role;
update app.bancas set created_at = now() - interval '1 hour' where code = 'antigaaa-0001';
do $$ begin perform pg_temp.como_dono();
  perform api.owner_create_banca('novaaaaa-0002', 'Banca Nova', 30000, 3, false, null); end $$;
reset role;

set local role service_role;
select is(api.public_home() ->> 'codigo', 'novaaaaa-0002', 'abre a banca criada por último');
reset role;

-- Pausada continua sendo a atual (a página mostra "Banca pausada").
update app.bancas set status = 'fechada', closed_at = now() where code = 'novaaaaa-0002';
set local role service_role;
select is(api.public_home() ->> 'codigo', 'novaaaaa-0002', 'banca pausada continua sendo a atual');
reset role;

-- Encerrada sai: volta para a anterior que ainda existe (banca aberta vale mais que o aviso).
update app.bancas set status = 'encerrada', ended_at = now(), code = null where name = 'Banca Nova';
set local role service_role;
select is(api.public_home(), '{"codigo": "antigaaa-0001", "encerrada": false}'::jsonb, 'encerrada não conta; volta para a anterior');
reset role;

-- Sem banca e encerramento recente: "Bancas encerradas".
update app.bancas set status = 'encerrada', ended_at = now() - interval '29 minutes', code = null where name = 'Banca Antiga';
update app.bancas set ended_at = now() - interval '29 minutes' where name = 'Banca Nova';
set local role service_role;
select is(api.public_home(), '{"codigo": null, "encerrada": true}'::jsonb, 'encerrada há menos de 30 min: tela de encerrada');
reset role;

-- Passados 30 min: volta para "Aguardando banca...".
update app.bancas set ended_at = now() - interval '31 minutes';
set local role service_role;
select is(api.public_home(), '{"codigo": null, "encerrada": false}'::jsonb, 'depois de 30 min: aguardando de novo');
reset role;

set local role anon;
select throws_ok($$ select api.public_home() $$, '42501', null, 'anon não chama a função');
reset role;
set local role authenticated;
select throws_ok($$ select api.public_home() $$, '42501', null, 'authenticated não chama a função');
reset role;

select * from finish();
rollback;
