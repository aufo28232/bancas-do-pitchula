-- D-091: fila cheia sem avalanche de avisos; inscrição repetida recupera o próprio pedido.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

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

create function pg_temp.h(p text) returns bytea language sql immutable as $$ select sha256(convert_to(p, 'UTF8')) $$;
create function pg_temp.como_dono() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', '00000000-0000-0000-0000-0000000000d1', 'role', 'authenticated', 'aal', 'aal2',
    'session_id', '00000000-0000-0000-0000-00000000007a', 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.pedido(p_id uuid, p_cpf text) returns text language sql as $$
  select api.public_create_order(
    'filachei-0001', p_id,
    'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), null,
    pg_temp.h('cpf:' || p_cpf), pg_temp.h('pix:' || p_cpf), null, pg_temp.h('ip:' || p_cpf), 1::smallint,
    array[pg_temp.h('cpf:' || p_cpf)], array[pg_temp.h('pix:' || p_cpf)], array[]::bytea[], array[pg_temp.h('ip:' || p_cpf)],
    pg_temp.h('token:' || p_id::text))
$$;

do $$ begin perform pg_temp.como_dono();
  perform api.owner_create_banca('filachei-0001', 'Fila Cheia', 100000, 100, false, null, 'Teste', 'https://teste.com/x', '1win'); end $$;
reset role;

-- 50 pedidos na fila.
set local role service_role;
do $$ begin for i in 1..50 loop perform pg_temp.pedido(gen_random_uuid(), i::text); end loop; end $$;
reset role;

-- 1. Um pedido sai da fila: só os avisos DELE (pedido + painel), não um por pessoa.
delete from realtime.messages;
update app.orders set status = 'recusado', refused_at = now(), refused_by = '00000000-0000-0000-0000-0000000000d1',
       refusal_reason = 'outro' where numero = 1;
select is((select count(*)::int from realtime.messages), 2, 'pedido que sai gera 2 avisos, com 49 pessoas atrás');

-- 2. A fila do painel continua com as posições certas (1..49, sem buracos).
do $$ begin perform pg_temp.como_dono(); end $$;
select is((select array_agg((p ->> 'posicao')::int order by (p ->> 'posicao')::int)
             from jsonb_array_elements(api.staff_list_queue((select id from app.bancas where code = 'filachei-0001')) -> 'pedidos') p),
          (select array_agg(g) from generate_series(1, 49) g), 'painel: posições 1..49 depois da saída');
select is((select (p ->> 'numero')::int from jsonb_array_elements(api.staff_list_queue((select id from app.bancas where code = 'filachei-0001')) -> 'pedidos') p
            where (p ->> 'posicao')::int = 1), 2, 'o #2 virou o primeiro da fila');
reset role;

-- 3. Esgotar e recusar as sobras: o painel não recebe 1 aviso por pedido recusado.
delete from realtime.messages;
update app.orders set status = 'recusado', refused_at = now(), refused_by = '00000000-0000-0000-0000-0000000000d1',
       refusal_reason = 'vagas_esgotadas' where status = 'pendente' and numero > 40;
select is((select count(*)::int from realtime.messages where topic like 'staff:%'), 0, 'recusa em massa por esgotar não inunda o painel');
select is((select count(*)::int from realtime.messages where topic like 'pedido:%' and event = 'status'), 10,
  'cada recusado ainda recebe o próprio aviso');

-- 4. Recuperar o pedido de uma tentativa que "girou".
set local role service_role;
select is(pg_temp.pedido('00000000-0000-0000-0000-00000000aaaa', '777'), 'ok', 'pedido da tentativa entra');
select is(api.srv_reclaim_order('00000000-0000-0000-0000-00000000aaaa', array[pg_temp.h('cpf:000')], pg_temp.h('novo-token-1')),
  false, 'outro CPF não recupera o pedido');
select is(api.srv_reclaim_order('00000000-0000-0000-0000-00000000aaaa', array[pg_temp.h('cpf:777')], pg_temp.h('novo-token-2')),
  true, 'mesma tentativa + mesmo CPF recupera o pedido');
select is(api.srv_open_order_session(pg_temp.h('novo-token-2'), pg_temp.h('sessao-nova')),
  '00000000-0000-0000-0000-00000000aaaa'::uuid, 'o novo token abre a sessão do pedido recuperado');
reset role;
update app.orders set created_at = now() - interval '16 minutes' where id = '00000000-0000-0000-0000-00000000aaaa';
set local role service_role;
select is(api.srv_reclaim_order('00000000-0000-0000-0000-00000000aaaa', array[pg_temp.h('cpf:777')], pg_temp.h('novo-token-3')),
  false, 'depois de 15 min não recupera mais');
reset role;

select * from finish();
rollback;
