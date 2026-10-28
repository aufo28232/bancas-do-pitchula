-- Etapa 4: sessão do pedido, estado, mensagens, prazo de 5 min e autorização do tempo real.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

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
insert into auth.users (id, is_anonymous) values
  ('00000000-0000-0000-0000-0000000000e1', true),
  ('00000000-0000-0000-0000-0000000000e2', true);
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

create function pg_temp.como_staff(p_uid text, p_session text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal2', 'session_id', p_session, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.como_espectador(p_uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', 'aal1', 'is_anonymous', true)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- O Realtime autoriza o canal fazendo um SELECT em realtime.messages com o tópico na sessão.
create function pg_temp.pode_ouvir(p_topic text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform set_config('realtime.topic', p_topic, true);
  select exists (select 1 from realtime.messages) into v;
  return v;
end $$;

create function pg_temp.pedido(p_id uuid, p_code text, p_cpf text, p_token text) returns text language sql as $$
  select api.public_create_order(
    p_code, p_id,
    'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), 'v1:' || repeat('D', 32),
    pg_temp.h('cpf:' || p_cpf), pg_temp.h('pix:' || p_cpf), pg_temp.h('pid:' || p_cpf), pg_temp.h('ip:' || p_cpf),
    1::smallint,
    array[pg_temp.h('cpf:' || p_cpf)], array[pg_temp.h('pix:' || p_cpf)],
    array[pg_temp.h('pid:' || p_cpf)], array[pg_temp.h('ip:' || p_cpf)],
    pg_temp.h('token:' || p_token))
$$;

-- Banca com 2 vagas e três pedidos (P1, P2, P3) ------------------------------------------
do $$ begin perform pg_temp.como_staff('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a'); end $$;
select ok((select id from api.owner_create_banca('tempreal-0001', 'Banca ao vivo', 200000, 2, true, null)) is not null, 'banca criada');
reset role;

set local role service_role;
select is(pg_temp.pedido('00000000-0000-0000-0000-0000000000b1', 'tempreal-0001', '1', 'um'), 'ok', 'pedido 1 entra');
select is(pg_temp.pedido('00000000-0000-0000-0000-0000000000b2', 'tempreal-0001', '2', 'dois'), 'ok', 'pedido 2 entra');
select is(pg_temp.pedido('00000000-0000-0000-0000-0000000000b3', 'tempreal-0001', '3', 'tres'), 'ok', 'pedido 3 entra');

-- 1. Sessão do pedido ------------------------------------------------------------------
select is(api.srv_open_order_session(pg_temp.h('token:errado'), pg_temp.h('s:x')), null, 'token errado não abre sessão');
select is(api.srv_open_order_session(pg_temp.h('token:um'), pg_temp.h('s:1')), '00000000-0000-0000-0000-0000000000b1'::uuid,
  'token certo abre a sessão do pedido');
select is(api.srv_open_order_session(pg_temp.h('token:dois'), pg_temp.h('s:2')), '00000000-0000-0000-0000-0000000000b2'::uuid,
  'outro pedido, outra sessão');
select is(api.srv_open_order_session(pg_temp.h('token:tres'), pg_temp.h('s:3')), '00000000-0000-0000-0000-0000000000b3'::uuid,
  'terceiro pedido, terceira sessão');

select throws_ok($$ select api.srv_bind_viewer(pg_temp.h('s:1'), '00000000-0000-0000-0000-0000000000a2') $$, '22023', null,
  'só usuário ANÔNIMO pode ser vinculado como espectador');
select ok(api.srv_bind_viewer(pg_temp.h('s:1'), '00000000-0000-0000-0000-0000000000e1'), 'espectador anônimo vinculado ao pedido 1');
select ok(api.srv_bind_viewer(pg_temp.h('s:2'), '00000000-0000-0000-0000-0000000000e2'), 'espectador anônimo vinculado ao pedido 2');
select ok(not api.srv_bind_viewer(pg_temp.h('s:nenhuma'), '00000000-0000-0000-0000-0000000000e1'), 'sessão inexistente não vincula');

-- 2. Estado e posição na fila ---------------------------------------------------------
select is((api.srv_viewer_state(pg_temp.h('s:1')) -> 'pedido' ->> 'posicao')::int, 1, 'pedido 1 é o primeiro da fila');
select is((api.srv_viewer_state(pg_temp.h('s:3')) -> 'pedido' ->> 'posicao')::int, 3, 'pedido 3 é o terceiro da fila');
select ok(
  not (api.srv_viewer_state(pg_temp.h('s:1'))::text ~* 'hmac|token|ip_|viewer_uid|locked_by'),
  'estado do pedido não carrega HMAC, token, IP nem ids internos de staff');
select is(api.srv_viewer_state(pg_temp.h('s:nenhuma')), null, 'sessão inexistente não lê estado');
reset role;

-- 3. Broadcast gerado pelo banco ------------------------------------------------------
select ok(exists (select 1 from realtime.messages where topic = 'pedido:00000000-0000-0000-0000-0000000000b3'
                   and event = 'posicao' and payload ->> 'posicao' = '3'), 'posição é transmitida no tópico do pedido');
select ok(not exists (select 1 from realtime.messages where topic like 'staff:%'
                       and payload::text ~ 'v1:|nome|cpf|pix'), 'tópico do painel não leva dados pessoais');

update app.orders set locked_by = '00000000-0000-0000-0000-0000000000a2', locked_at = now(), lock_activity_at = now()
 where id = '00000000-0000-0000-0000-0000000000b1';
select ok(exists (select 1 from realtime.messages where topic = 'pedido:00000000-0000-0000-0000-0000000000b1'
                   and event = 'assumido' and payload ->> 'atendente' = 'Mod Um'), 'evento "assumido" (beep) ao travar o pedido');

-- 4. Prazo de 5 minutos (D-043) ------------------------------------------------------
update app.orders set reply_deadline_at = now() + interval '5 minutes' where id = '00000000-0000-0000-0000-0000000000b1';
select ok(exists (select 1 from realtime.messages where topic = 'pedido:00000000-0000-0000-0000-0000000000b1' and event = 'prazo'),
  'prazo é transmitido ao espectador');
set local role service_role;
select is(api.srv_viewer_post_message(pg_temp.h('s:1'), 'Mandei o comprovante'), 'ok', 'espectador responde dentro do prazo');
reset role;
select is((select reply_deadline_at from app.orders where id = '00000000-0000-0000-0000-0000000000b1'), null,
  'a resposta do espectador para o relógio');

update app.orders set locked_by = '00000000-0000-0000-0000-0000000000a2', locked_at = now(), lock_activity_at = now(),
                      reply_deadline_at = now() - interval '1 second'
 where id = '00000000-0000-0000-0000-0000000000b2';
set local role service_role;
select is(api.srv_viewer_post_message(pg_temp.h('s:2'), 'Cheguei atrasado'), 'finalizado', 'mensagem depois do prazo é recusada');
reset role;
select is((select status::text || '/' || refusal_reason::text from app.orders where id = '00000000-0000-0000-0000-0000000000b2'),
  'recusado/sem_resposta', 'pedido expirou como recusado por falta de resposta');
select is((select refused from app.banca_stats s join app.bancas b on b.id = s.banca_id where b.code = 'tempreal-0001'), 1,
  'estatística de recusados contou a expiração');
select ok(exists (select 1 from app.audit_log where action = 'pedido_expirado' and actor_role = 'sistema'),
  'expiração vai para a auditoria');
select is((api.srv_viewer_state(pg_temp.h('s:3')) -> 'pedido' ->> 'posicao')::int, 2, 'quem estava atrás sobe na fila');
select ok(exists (select 1 from realtime.messages where topic = 'pedido:00000000-0000-0000-0000-0000000000b3'
                   and event = 'posicao' and payload ->> 'posicao' = '2'), 'a nova posição é transmitida para quem subiu');

update app.orders set locked_by = '00000000-0000-0000-0000-0000000000a2', locked_at = now(), lock_activity_at = now(),
                      reply_deadline_at = now() - interval '1 second'
 where id = '00000000-0000-0000-0000-0000000000b3';
select is(app.expire_unanswered(), 1, 'o job expira os prazos vencidos que ninguém tocou');

-- 5. Autorização dos canais (RLS em realtime.messages) -----------------------------------
do $$ begin perform pg_temp.como_espectador('00000000-0000-0000-0000-0000000000e1'); end $$;
select ok(pg_temp.pode_ouvir('pedido:00000000-0000-0000-0000-0000000000b1'), 'espectador ouve o próprio pedido');
select ok(not pg_temp.pode_ouvir('pedido:00000000-0000-0000-0000-0000000000b2'), 'espectador NÃO ouve o pedido de outra pessoa');
select ok(not pg_temp.pode_ouvir('staff:' || (select id from app.bancas where code = 'tempreal-0001')),
  'espectador NÃO ouve o canal do painel');
select throws_ok($$ insert into realtime.messages (topic, event, payload) values ('pedido:00000000-0000-0000-0000-0000000000b1', 'status', '{}') $$,
  '42501', null, 'espectador NÃO emite broadcast');
reset role;

do $$ begin perform pg_temp.como_staff('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b'); end $$;
select ok(pg_temp.pode_ouvir('staff:00000000-0000-0000-0000-000000000000'), 'moderador com MFA e sessão viva ouve o painel');
reset role;

set local role anon;
select ok(pg_temp.pode_ouvir('vagas:tempreal-0001') and not pg_temp.pode_ouvir('pedido:00000000-0000-0000-0000-0000000000b1'),
  'visitante só ouve as vagas');
reset role;

select * from finish();
rollback;
