-- Etapa 6: comprovantes, encerramento com exclusão imediata, encerramento automático,
-- retenção e exclusão a pedido do titular.
begin;
create extension if not exists pgtap with schema extensions;
select plan(43);

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
delete from app.storage_purge_queue;
delete from app.auth_purge_queue;
update app.quick_replies set created_by = null;
delete from app.staff;
set local app.audit_purge = 'off';

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod@teste.local');
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-0000000000e1', true),
  ('00000000-0000-0000-0000-0000000000e2', true);
insert into auth.users (id, is_anonymous, created_at) values
  ('00000000-0000-0000-0000-0000000000e9', true, now() - interval '2 days');
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
create function pg_temp.como(p_uid text, p_session text, p_aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'session_id', p_session, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.dono() returns void language sql as $$
  select pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a') $$;
create function pg_temp.mod() returns void language sql as $$
  select pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b') $$;
create function pg_temp.pedido(p_id uuid, p_code text, p_cpf text) returns text language sql as $$
  select api.public_create_order(
    p_code, p_id,
    'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), 'v1:' || repeat('D', 32),
    pg_temp.h('cpf:' || p_cpf), pg_temp.h('pix:' || p_cpf), pg_temp.h('pid:' || p_cpf), pg_temp.h('ip:' || p_cpf),
    1::smallint,
    array[pg_temp.h('cpf:' || p_cpf)], array[pg_temp.h('pix:' || p_cpf)],
    array[pg_temp.h('pid:' || p_cpf)], array[pg_temp.h('ip:' || p_cpf)],
    pg_temp.h('token:' || p_cpf))
$$;
create function pg_temp.anexo(p_sessao text, p_order uuid, p_id uuid) returns text language sql as $$
  select api.srv_viewer_add_attachment(
    pg_temp.h(p_sessao), p_id,
    'comprovantes/' || current_setting('teste.banca') || '/' || p_order || '/' || p_id || '.webp',
    1000, 800, 600, pg_temp.h(p_id::text))
$$;
create function pg_temp.banca(p_code text) returns uuid language sql as $$ select id from app.bancas where code = p_code $$;

do $$ begin perform pg_temp.dono(); end $$;
select ok((select id from api.owner_create_banca('encerrar-0001', 'Banca do Sábado', 20000, 2, false, null)) is not null, 'banca criada');
reset role;
do $$ begin perform set_config('teste.banca', pg_temp.banca('encerrar-0001')::text, true); end $$;
set local role service_role;
do $$ begin
  perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b1', 'encerrar-0001', '1');
  perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b2', 'encerrar-0001', '2');
  perform api.srv_open_order_session(pg_temp.h('token:2'), pg_temp.h('s:2'));
  perform api.srv_bind_viewer(pg_temp.h('s:2'), '00000000-0000-0000-0000-0000000000e2');
  perform api.srv_open_order_session(pg_temp.h('token:1'), pg_temp.h('s:1'));
end $$;

-- 1. Comprovantes -----------------------------------------------------------------
select throws_ok($$ select api.srv_viewer_add_attachment(pg_temp.h('s:2'), gen_random_uuid(), 'comprovantes/x/y/z.webp', 1, 1, 1, pg_temp.h('x')) $$,
  '22023', null, 'caminho que não é o do próprio pedido é recusado');
select is(pg_temp.anexo('s:2', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000f001'), 'ok', 'espectador envia comprovante');
reset role;
select ok((select has_receipt from app.orders where id = '00000000-0000-0000-0000-0000000000b2'), 'pedido passa a ter comprovante');
select ok(exists (select 1 from app.order_messages where attachment_id = '00000000-0000-0000-0000-00000000f001' and author = 'espectador'),
  'comprovante aparece no chat');
set local role service_role;
do $$ begin
  perform pg_temp.anexo('s:2', '00000000-0000-0000-0000-0000000000b2', ('00000000-0000-0000-0000-00000000f00' || n)::uuid) from generate_series(2, 5) n;
end $$;
select is(pg_temp.anexo('s:2', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-00000000f006'), 'limite',
  'sexto comprovante é recusado (máximo 5, D-021)');
select ok(api.srv_viewer_attachment_path(pg_temp.h('s:2'), '00000000-0000-0000-0000-00000000f001') like 'comprovantes/%.webp',
  'dono do pedido obtém o caminho do próprio comprovante');
select is(api.srv_viewer_attachment_path(pg_temp.h('s:1'), '00000000-0000-0000-0000-00000000f001'), null,
  'outro espectador NÃO obtém o comprovante alheio');
reset role;

do $$ begin perform pg_temp.mod(); end $$;
select ok(api.staff_attachment_path('00000000-0000-0000-0000-00000000f001') is not null, 'moderador abre o comprovante');
reset role;
select ok(exists (select 1 from app.audit_log where action = 'abrir_comprovante'), 'abrir comprovante vai para a auditoria');
set local role anon;
select throws_ok($$ select api.staff_attachment_path('00000000-0000-0000-0000-00000000f001') $$, '42501', null,
  'visitante NÃO abre comprovante');
reset role;

-- Paga o pedido 1 (para conferir os agregados depois).
do $$ begin perform pg_temp.mod(); perform api.staff_claim('00000000-0000-0000-0000-0000000000b1', null);
  perform api.staff_mark_paid('00000000-0000-0000-0000-0000000000b1', null); end $$;
reset role;

-- 2. Encerrar = apagar tudo na hora (D-044, D-045) ---------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b', 'aal1'); end $$;
select throws_ok($$ select api.staff_end_banca(pg_temp.banca('encerrar-0001'), 'Banca do Sábado', null) $$, '42501', null,
  'moderador em AAL1 NÃO encerra');
reset role;
do $$ begin perform pg_temp.mod(); end $$;
select throws_ok($$ select api.staff_end_banca(pg_temp.banca('encerrar-0001'), 'Banca errada', null) $$, 'BP005', null,
  'nome de confirmação errado: recusado');
select is((api.staff_end_banca(pg_temp.banca('encerrar-0001'), '  banca do sábado ', '00000000-0000-0000-0000-0000000000d1') ->> 'pagos')::int, 1,
  'moderador AAL2 encerra digitando o nome (sem diferenciar maiúsculas)');
select is((select ended_by from app.bancas where name = 'Banca do Sábado'), '00000000-0000-0000-0000-0000000000a2'::uuid,
  'quem encerrou fica registrado');
select is((select (r ->> 'pagos')::int from (select api.staff_end_banca(
             (select id from app.bancas where name = 'Banca do Sábado'), 'Banca do Sábado', '00000000-0000-0000-0000-0000000000d1') as r) x), 1,
  'clique duplo (mesma chave) devolve o mesmo resultado');
reset role;

select is((select count(*)::int from app.orders o join app.bancas b on b.id = o.banca_id where b.name = 'Banca do Sábado'), 0,
  'todos os pedidos da banca foram apagados');
select is((select count(*)::int from app.order_messages), 0, 'mensagens apagadas');
select is((select count(*)::int from app.order_attachments), 0, 'registros de comprovante apagados');
select is((select count(*)::int from app.order_sessions), 0, 'sessões dos espectadores apagadas');
select is((select count(*)::int from app.storage_purge_queue where done_at is null and storage_path like 'comprovantes/%'), 5,
  'os 5 arquivos foram para a fila de exclusão do Storage');
select ok(exists (select 1 from app.auth_purge_queue where user_id = '00000000-0000-0000-0000-0000000000e2'),
  'a conta anônima do espectador foi para a fila de exclusão');
select is((select status::text || '/' || coalesce(code, 'sem-codigo') from app.bancas where name = 'Banca do Sábado'),
  'encerrada/sem-codigo', 'banca encerrada e o link deixa de existir');
select ok((select ended_at is not null from app.bancas where name = 'Banca do Sábado'), 'ended_at gravado');
select is((select received || '/' || paid || '/' || total_paid_cents from app.banca_stats s join app.bancas b on b.id = s.banca_id
            where b.name = 'Banca do Sábado'), '2/1/10000', 'agregados preservados (recebidos/pagos/total)');
set local role service_role;
select is((select count(*)::int from api.public_get_banca('encerrar-0001')), 0, 'página pública não acha mais a banca');
reset role;
select ok(exists (select 1 from realtime.messages where topic = 'pedido:00000000-0000-0000-0000-0000000000b2' and event = 'banca_encerrada')
          and exists (select 1 from realtime.messages where topic = 'vagas:encerrar-0001' and event = 'banca_encerrada')
          and exists (select 1 from realtime.messages where topic like 'staff:%' and event = 'banca_encerrada'),
  'espectadores, página da banca e painel são avisados');
select ok(exists (select 1 from app.audit_log where action = 'banca_encerrar' and (detail ->> 'recebidos')::int = 2
                    and not (detail::text ~ 'v1:|cpf|pix')), 'auditoria do encerramento só com contagens');

-- 3. Encerramento automático (D-005) --------------------------------------------------
do $$ begin perform pg_temp.dono();
  perform api.owner_create_banca('fechada7-0001', 'Fechada', 10000, 1, false, null);
  perform api.owner_create_banca('esgotad1-0001', 'Esgotada', 10000, 1, false, null);
  perform api.owner_create_banca('parada77-0001', 'Parada', 10000, 1, false, null);
  perform api.owner_create_banca('ativa777-0001', 'Ativa', 10000, 1, false, null); end $$;
reset role;
update app.bancas set status = 'fechada', closed_at = now() - interval '8 days' where code = 'fechada7-0001';
update app.bancas set status = 'esgotada', paid_count = 1, sold_out_at = now() - interval '25 hours' where code = 'esgotad1-0001';
update app.bancas set last_activity_at = now() - interval '8 days' where code = 'parada77-0001';
select is(app.auto_end_bancas(), 3, 'encerra fechada há 7 dias, esgotada há 24h e aberta parada há 7 dias');
select is((select status::text from app.bancas where code = 'ativa777-0001'), 'aberta', 'banca ativa continua aberta');
select ok(exists (select 1 from app.audit_log where action = 'banca_encerrar' and actor_role = 'sistema' and detail ->> 'motivo' = 'esgotada_24h'),
  'encerramento automático auditado como sistema, com o motivo');

-- 4. Exclusão a pedido do titular (D-018) ----------------------------------------------
set local role service_role;
do $$ begin
  perform pg_temp.pedido('00000000-0000-0000-0000-0000000000c1', 'ativa777-0001', '7');
  perform api.srv_open_order_session(pg_temp.h('token:7'), pg_temp.h('s:7'));
  perform api.srv_bind_viewer(pg_temp.h('s:7'), '00000000-0000-0000-0000-0000000000e1'); end $$;
select is(api.srv_viewer_delete(pg_temp.h('s:7')), 'ok', 'espectador pede para excluir os dados');
select is(api.srv_viewer_state(pg_temp.h('s:7')), null, 'o link para de funcionar');
select is(pg_temp.pedido(gen_random_uuid(), 'ativa777-0001', '7'), 'bloqueado', 'mesmo CPF não faz outro pedido na mesma banca');
reset role;
select is((select status::text || '/' || refusal_reason::text from app.orders where id = '00000000-0000-0000-0000-0000000000c1'),
  'recusado/exclusao_a_pedido', 'pendente vira recusado por exclusão a pedido');
select ok((select full_name_enc like 'v0:%' and cpf_enc like 'v0:%' and pix_key_enc like 'v0:%' and platform_id_enc like 'v0:%'
                  and data_erased_at is not null and viewer_uid is null
             from app.orders where id = '00000000-0000-0000-0000-0000000000c1'),
  'dados pessoais substituídos por valores que não decifram');
select is((select count(*)::int from app.order_messages where order_id = '00000000-0000-0000-0000-0000000000c1'), 0, 'chat apagado');

-- 5. Retenção -------------------------------------------------------------------------
insert into app.bans (kind, value_hmac, hmac_key_version, scope, reason, created_by, created_at, expires_at, review_due_at, lifted_at, lifted_by) values
  ('ip',  pg_temp.h('r1'), 1, 'global', 'vencido', '00000000-0000-0000-0000-0000000000a1', now() - interval '8 days', now() - interval '1 day', null, null, null),
  ('cpf', pg_temp.h('r2'), 1, 'global', 'levantado', '00000000-0000-0000-0000-0000000000a1', now() - interval '60 days', null, now() + interval '300 days',
          now() - interval '31 days', '00000000-0000-0000-0000-0000000000a1'),
  ('cpf', pg_temp.h('r3'), 1, 'global', 'revisao vencida', '00000000-0000-0000-0000-0000000000a1', now() - interval '400 days', null,
          now() - interval '31 days', null, null),
  ('cpf', pg_temp.h('r4'), 1, 'global', 'ativo', '00000000-0000-0000-0000-0000000000a1', now(), null, now() + interval '1 year', null, null);
insert into app.idempotency_keys (actor_id, key, action, created_at) values (gen_random_uuid(), gen_random_uuid(), 'velha', now() - interval '2 days');
select is((app.retencao() ->> 'bans')::int, 3, 'retenção apaga ban de IP vencido, levantado há 30 dias e revisão vencida há 30 dias (D-020)');
select is((select count(*)::int from app.bans), 1, 'o ban ativo continua');
select is((select count(*)::int from app.idempotency_keys where action = 'velha'), 0, 'chaves de idempotência antigas apagadas');
select ok(exists (select 1 from app.auth_purge_queue where user_id = '00000000-0000-0000-0000-0000000000e9'),
  'conta anônima sem pedido há mais de 1 dia vai para a fila');

-- 6. Fila do trabalhador de limpeza -----------------------------------------------------
set local role service_role;
select ok(jsonb_array_length(api.srv_purge_batch(100) -> 'arquivos') = 5, 'trabalhador recebe os arquivos pendentes');
reset role;
do $$ begin
  perform api.srv_purge_done(array(select id from app.storage_purge_queue), '{}', array(select user_id from app.auth_purge_queue), '{}', null);
end $$;
set local role service_role;
select is(jsonb_array_length(api.srv_purge_batch(100) -> 'arquivos'), 0, 'depois de apagados, saem da fila');
reset role;

select * from finish();
rollback;
