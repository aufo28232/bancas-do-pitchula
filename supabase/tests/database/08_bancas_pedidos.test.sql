-- Etapa 3: bancas (painel) e criação de pedido (público).
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- Isola este arquivo de dados deixados por outros testes (o rollback no fim desfaz tudo).
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

create function pg_temp.como(p_uid text, p_session text)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_session, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.h(p text) returns bytea language sql immutable as $$ select sha256(convert_to(p, 'UTF8')) $$;

-- Pedido de teste: dados já "cifrados" e HMACs como o servidor manda.
create function pg_temp.pedido(p_code text, p_cpf text, p_ip text, p_pix text default null)
returns text language sql as $$
  select api.public_create_order(
    p_code, gen_random_uuid(),
    'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), 'v1:' || repeat('D', 32),
    pg_temp.h('cpf:' || p_cpf), pg_temp.h('pix:' || coalesce(p_pix, p_cpf)), pg_temp.h('pid:' || p_cpf), pg_temp.h('ip:' || p_ip),
    1::smallint,
    array[pg_temp.h('cpf:' || p_cpf)], array[pg_temp.h('pix:' || coalesce(p_pix, p_cpf))],
    array[pg_temp.h('pid:' || p_cpf)], array[pg_temp.h('ip:' || p_ip)],
    pg_temp.h(gen_random_uuid()::text))
$$;

-- 1. Quem pode o quê -------------------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b'); end $$;
select throws_ok($$ select * from api.owner_create_banca('modmodmo-0001', 'X', 1000, 1, true, null) $$, '42501', null,
  'moderador NÃO cria banca');
select throws_ok($$ select pg_temp.pedido('qualquer-0001', '1', '1') $$, '42501', null,
  'staff NÃO chama a criação de pedido direto (só o servidor)');
reset role;

set local role anon;
select throws_ok($$ select * from api.public_get_banca('aaaaaaaa-0001') $$, '42501', null,
  'visitante sem servidor não consulta a banca direto no banco');
reset role;

-- 2. Criação de banca + idempotência ----------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a'); end $$;
select is(
  (select per_person_cents from api.owner_create_banca('aaaaaaaa-0001', 'Banca da sexta', 300000, 3, true, '00000000-0000-0000-0000-0000000000f1')),
  100000::bigint, 'streamer cria banca: R$ 3.000 ÷ 3 = R$ 1.000 por pessoa');
select is(
  (select code from api.owner_create_banca('outrocod-0002', 'Banca da sexta', 300000, 3, true, '00000000-0000-0000-0000-0000000000f1')),
  'aaaaaaaa-0001', 'clique duplo (mesma chave de idempotência) devolve a MESMA banca');
reset role;
select is((select count(*)::int from app.bancas where name = 'Banca da sexta'), 1, 'só uma banca foi criada');

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b'); end $$;
select is((select count(*)::int from api.staff_list_bancas()), 1, 'moderador enxerga a lista de bancas');
select throws_ok($$ select api.owner_set_banca_status((select id from app.bancas where code = 'aaaaaaaa-0001'), 'fechar') $$,
  '42501', null, 'moderador NÃO fecha banca');
reset role;

-- 3. Pedidos: duplicidade por CPF e por IP --------------------------------------------
set local role service_role;
select is((select restantes from api.public_get_banca('aaaaaaaa-0001')), 3, 'página pública mostra as vagas restantes');
select is(pg_temp.pedido('aaaaaaaa-0001', '11111111111', '10.0.0.1'), 'ok', 'primeiro pedido entra');
select is(pg_temp.pedido('aaaaaaaa-0001', '11111111111', '10.0.0.2'), 'bloqueado', 'mesmo CPF na mesma banca: bloqueado');
select is(pg_temp.pedido('aaaaaaaa-0001', '22222222222', '10.0.0.1'), 'bloqueado', 'mesmo IP com a regra ligada: bloqueado');
select is(pg_temp.pedido('naoexist-0000', '33333333333', '10.0.0.3'), 'indisponivel', 'banca inexistente: indisponível');
reset role;

select is((select order_count from app.bancas where code = 'aaaaaaaa-0001'), 1, 'contador de pedidos conta só o que entrou');
select is((select count(*)::int from app.order_messages m join app.orders o on o.id = m.order_id where m.author = 'sistema'), 1,
  'pedido nasce com a mensagem de sistema pedindo o comprovante');
select ok(
  not exists (select 1 from app.audit_log where action = 'pedido_bloqueado'
               and (detail::text ~ '[0-9]{11}' or detail ?| array['cpf', 'pix', 'ip'])),
  'auditoria de bloqueio guarda só o motivo, nunca o dado');

-- 4. Edição: valor e vagas travam depois do primeiro pedido ------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a'); end $$;
select throws_ok($$ select api.owner_update_banca((select id from app.bancas where code = 'aaaaaaaa-0001'), 1, 'Banca', 500000, null, null) $$,
  '55000', null, 'valor NÃO muda depois do primeiro pedido');
select throws_ok($$ select api.owner_update_banca((select id from app.bancas where code = 'aaaaaaaa-0001'), 1, 'Banca', null, 10, null) $$,
  '55000', null, 'vagas NÃO mudam depois do primeiro pedido');
select is(api.owner_update_banca((select id from app.bancas where code = 'aaaaaaaa-0001'), 1, 'Banca de sexta à noite', null, null, false), 2,
  'nome e "1 por IP" mudam sempre');
select throws_ok($$ select api.owner_update_banca((select id from app.bancas where code = 'aaaaaaaa-0001'), 1, 'Velha', null, null, null) $$,
  '40001', null, 'edição com versão desatualizada é recusada (outra aba editou antes)');
reset role;

set local role service_role;
select is(pg_temp.pedido('aaaaaaaa-0001', '44444444444', '10.0.0.1'), 'ok', 'com a regra desligada, o mesmo IP volta a ser aceito');
reset role;

-- 5. Banimentos -------------------------------------------------------------------------
insert into app.bans (kind, value_hmac, hmac_key_version, scope, reason, created_by, review_due_at)
values ('cpf', pg_temp.h('cpf:55555555555'), 1, 'global', 'fraude', '00000000-0000-0000-0000-0000000000a1', now() + interval '12 months');
insert into app.bans (kind, value_hmac, hmac_key_version, scope, reason, created_by, created_at, expires_at)
values ('ip', pg_temp.h('ip:10.9.9.9'), 1, 'global', 'flood antigo', '00000000-0000-0000-0000-0000000000a1', now() - interval '3 days', now() - interval '1 day');

set local role service_role;
select is(pg_temp.pedido('aaaaaaaa-0001', '55555555555', '10.0.0.5'), 'bloqueado', 'CPF banido globalmente: bloqueado (mesma resposta do duplicado)');
select is(pg_temp.pedido('aaaaaaaa-0001', '66666666666', '10.9.9.9'), 'ok', 'ban de IP vencido não vale mais');
reset role;

-- 6. Sem teto de fila (D-032 revista): a banca aceita quantos pedidos chegarem ------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a'); end $$;
select lives_ok($$ select * from api.owner_create_banca('cccccccc-0003', 'Uma vaga', 1000, 1, false, null) $$, 'banca de 1 vaga');
reset role;
set local role service_role;
select is(
  array[pg_temp.pedido('cccccccc-0003', '70000000001', '1'), pg_temp.pedido('cccccccc-0003', '70000000002', '1'),
        pg_temp.pedido('cccccccc-0003', '70000000003', '1'), pg_temp.pedido('cccccccc-0003', '70000000004', '1'),
        pg_temp.pedido('cccccccc-0003', '70000000005', '1')],
  array['ok', 'ok', 'ok', 'ok', 'ok'],
  'com 1 vaga, a fila aceita mais pedidos do que vagas (só vagas PAGAS esgotam a banca)');
reset role;

-- 7. Fechar e reabrir ---------------------------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a'); end $$;
select is(api.owner_set_banca_status((select id from app.bancas where code = 'aaaaaaaa-0001'), 'fechar')::text, 'fechada', 'streamer fecha a banca');
reset role;
set local role service_role;
select is(pg_temp.pedido('aaaaaaaa-0001', '88888888888', '10.0.0.8'), 'indisponivel', 'banca fechada não aceita pedido novo');
reset role;

select * from finish();
rollback;
