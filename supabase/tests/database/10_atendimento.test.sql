-- Etapa 5: atendimento no painel (travas, prazo, pagar, recusar, banir, modo live, respostas rápidas).
-- A concorrência real (duas transações ao mesmo tempo) é testada na integração, com
-- duas requisições simultâneas pelo PostgREST (DECISIONS D-071).
begin;
create extension if not exists pgtap with schema extensions;
select plan(58);

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
  ('00000000-0000-0000-0000-0000000000a2', 'mod1@teste.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'mod2@teste.local');
insert into app.staff (user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', 'Pitchula'),
  ('00000000-0000-0000-0000-0000000000a2', 'moderator', 'Mod Um'),
  ('00000000-0000-0000-0000-0000000000a3', 'moderator', 'Mod Dois');
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a3');
insert into app.staff_sessions (session_id, user_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a3');

create function pg_temp.h(p text) returns bytea language sql immutable as $$ select sha256(convert_to(p, 'UTF8')) $$;

create function pg_temp.como(p_uid text, p_session text, p_aal text default 'aal2') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'session_id', p_session, 'is_anonymous', false)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create function pg_temp.dono() returns void language sql as $$
  select pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a') $$;
create function pg_temp.mod1() returns void language sql as $$
  select pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b') $$;
create function pg_temp.mod2() returns void language sql as $$
  select pg_temp.como('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000005c') $$;

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

create function pg_temp.idem(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

-- Banca 1: 2 vagas, 4 pedidos (P1..P4). Banca 2 e 3 para banimentos.
do $$ begin perform pg_temp.dono(); end $$;
select ok((select id from api.owner_create_banca('atendime-0001', 'Banca 1', 20000, 2, false, null)) is not null, 'banca 1 criada');
select ok((select id from api.owner_create_banca('atendime-0002', 'Banca 2', 20000, 5, false, null)) is not null, 'banca 2 criada');
select ok((select id from api.owner_create_banca('atendime-0003', 'Banca 3', 20000, 5, false, null)) is not null, 'banca 3 criada');
reset role;
set local role service_role;
do $$ begin perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b1', 'atendime-0001', '1'); end $$;
do $$ begin perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b2', 'atendime-0001', '2'); end $$;
do $$ begin perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b3', 'atendime-0001', '3'); end $$;
do $$ begin perform pg_temp.pedido('00000000-0000-0000-0000-0000000000b4', 'atendime-0001', '4'); end $$;
do $$ begin perform pg_temp.pedido('00000000-0000-0000-0000-0000000000c1', 'atendime-0002', '9'); end $$;
do $$ begin perform api.srv_open_order_session(pg_temp.h('token:9'), pg_temp.h('sessao:9')); end $$;
reset role;

-- 1. Identidades -------------------------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b', 'aal1'); end $$;
select throws_ok($$ select api.staff_claim('00000000-0000-0000-0000-0000000000b1', null) $$, '42501', null,
  'moderador em AAL1 NÃO assume pedido');
select throws_ok($$ select api.staff_list_queue((select id from app.bancas where code = 'atendime-0001')) $$, '42501', null,
  'moderador em AAL1 NÃO vê a fila');
reset role;
set local role anon;
select throws_ok($$ select api.staff_get_order('00000000-0000-0000-0000-0000000000b1') $$, '42501', null,
  'visitante NÃO lê pedido');
reset role;

-- 2. Fila ------------------------------------------------------------------------------
do $$ begin perform pg_temp.mod1(); end $$;
select is(jsonb_array_length(api.staff_list_queue((select id from app.bancas where code = 'atendime-0001')) -> 'pedidos'), 4,
  'fila mostra os 4 pendentes');
select ok(not (api.staff_list_queue((select id from app.bancas where code = 'atendime-0001'))::text ~ 'hmac|token|ip_'),
  'fila não leva HMAC, token nem IP');
select is((api.staff_get_order('00000000-0000-0000-0000-0000000000b1') -> 'pedido' -> 'enc' ->> 'cpf'), 'v1:' || repeat('B', 32),
  'detalhe entrega o CPF CIFRADO (só o servidor decifra)');

-- 3. Travas -----------------------------------------------------------------------------
select is(api.staff_claim('00000000-0000-0000-0000-0000000000b1', pg_temp.idem(1)) ->> 'resultado', 'ok', 'Mod Um assume P1');
select is(api.staff_claim('00000000-0000-0000-0000-0000000000b1', pg_temp.idem(1)) ->> 'resultado', 'ok',
  'clique duplo (mesma chave) devolve o mesmo resultado');
reset role;
do $$ begin perform pg_temp.mod2(); end $$;
select throws_ok($$ select api.staff_claim('00000000-0000-0000-0000-0000000000b1', null) $$, 'BP001', null,
  'Mod Dois NÃO assume pedido travado por outro');
select throws_ok($$ select api.staff_send_message('00000000-0000-0000-0000-0000000000b1', 'oi') $$, 'BP001', null,
  'sem a trava não manda mensagem (e não inicia prazo)');
select throws_ok($$ select api.staff_mark_paid('00000000-0000-0000-0000-0000000000b1', null) $$, 'BP001', null,
  'sem a trava não marca pago');
select throws_ok($$ select api.owner_force_claim('00000000-0000-0000-0000-0000000000b1', null) $$, '42501', null,
  'moderador NÃO força assumir');
reset role;

-- 4. Prazo de 10 min (D-085, era 5 em D-043) iniciado pela mensagem de quem tem a trava (D-043) ---------------------
do $$ begin perform pg_temp.mod1(); end $$;
select ok(api.staff_send_message('00000000-0000-0000-0000-0000000000b1', 'Manda o comprovante') is not null, 'Mod Um manda mensagem');
reset role;
select ok((select reply_deadline_at between now() + interval '9 minutes 59 seconds' and now() + interval '10 minutes 1 second'
             from app.orders where id = '00000000-0000-0000-0000-0000000000b1'), 'mensagem do moderador inicia o prazo de 10 min');
do $$ begin perform pg_temp.mod1(); end $$;
select throws_ok($$ select api.staff_send_message('00000000-0000-0000-0000-0000000000b1', '   ') $$, 'BP005', null,
  'mensagem vazia é recusada');
reset role;

-- Trava expira com 10 min sem atividade (D-016): outro moderador pode assumir.
update app.orders set lock_activity_at = now() - interval '11 minutes', reply_deadline_at = null
 where id = '00000000-0000-0000-0000-0000000000b1';
do $$ begin perform pg_temp.mod2(); end $$;
select is(api.staff_claim('00000000-0000-0000-0000-0000000000b1', null) ->> 'resultado', 'ok', 'trava expirada: Mod Dois assume');
reset role;
select is((select app.staff_name(locked_by) from app.orders where id = '00000000-0000-0000-0000-0000000000b1'), 'Mod Dois',
  'a trava agora é do Mod Dois');
do $$ begin perform pg_temp.mod1(); end $$;
select throws_ok($$ select api.staff_send_message('00000000-0000-0000-0000-0000000000b1', 'ainda aqui?') $$, 'BP001', null,
  'quem perdeu a trava não manda mais mensagem');
reset role;

do $$ begin perform pg_temp.dono(); end $$;
select is(api.owner_force_claim('00000000-0000-0000-0000-0000000000b1', null) ->> 'resultado', 'ok', 'streamer força assumir');
reset role;
select ok(exists (select 1 from app.audit_log where action = 'forcar_assumir' and detail ->> 'moderador_anterior' = 'Mod Dois'),
  'forçar assumir vai para a auditoria com o moderador anterior');
do $$ begin perform pg_temp.mod2(); end $$;
select throws_ok($$ select api.staff_release('00000000-0000-0000-0000-0000000000b1', null) $$, 'BP001', null,
  'moderador NÃO libera a trava de outra pessoa');
reset role;
do $$ begin perform pg_temp.dono(); end $$;
select is(api.staff_release('00000000-0000-0000-0000-0000000000b1', null) ->> 'resultado', 'ok', 'streamer libera');
reset role;

-- 5. Recusar --------------------------------------------------------------------------
do $$ begin perform pg_temp.mod1(); end $$;
do $$ begin perform api.staff_claim('00000000-0000-0000-0000-0000000000b2', null); end $$;
select throws_ok($$ select api.staff_refuse('00000000-0000-0000-0000-0000000000b2', 'banido', null, null) $$, 'BP005', null,
  'motivo reservado ao sistema (banido) não pode ser escolhido');
select is(api.staff_refuse('00000000-0000-0000-0000-0000000000b2', 'comprovante_ilegivel', 'Print cortado', null) ->> 'resultado', 'ok',
  'recusa com motivo e nota');
select throws_ok($$ select api.staff_mark_paid('00000000-0000-0000-0000-0000000000b2', null) $$, 'BP002', null,
  'recusado NÃO vira pago');
reset role;

-- 6. Pagar: idempotência e última vaga (D-004) -------------------------------------------
do $$ begin perform pg_temp.mod1(); end $$;
do $$ begin perform api.staff_claim('00000000-0000-0000-0000-0000000000b3', null); end $$;
select is(api.staff_mark_paid('00000000-0000-0000-0000-0000000000b3', pg_temp.idem(7)) ->> 'esgotou', 'false', 'P3 pago (1 de 2)');
select is(api.staff_mark_paid('00000000-0000-0000-0000-0000000000b3', pg_temp.idem(7)) ->> 'resultado', 'ok',
  'clique duplo no pagar devolve o mesmo resultado');
select throws_ok($$ select api.staff_mark_paid('00000000-0000-0000-0000-0000000000b3', null) $$, 'BP002', null,
  'pagar de novo (outra chave) é recusado');
reset role;
select is((select paid_count from app.bancas where code = 'atendime-0001'), 1, 'paid_count contou UMA vez');

do $$ begin perform pg_temp.dono(); end $$;
select is(api.staff_mark_paid('00000000-0000-0000-0000-0000000000b1', null) ->> 'esgotou', 'true',
  'streamer paga a última vaga sem assumir (ninguém estava com o pedido)');
reset role;
select is((select status::text from app.bancas where code = 'atendime-0001'), 'esgotada', 'banca esgota');
select is((select status::text || '/' || refusal_reason::text from app.orders where id = '00000000-0000-0000-0000-0000000000b4'),
  'recusado/vagas_esgotadas', 'pendente que sobrou é recusado na hora com "vagas esgotadas"');
select is((select paid || '/' || refused || '/' || total_paid_cents from app.banca_stats s join app.bancas b on b.id = s.banca_id
            where b.code = 'atendime-0001'), '2/2/20000', 'resumo: 2 pagos, 2 recusados, R$ 200 pagos');
select ok(exists (select 1 from app.audit_log where action = 'pagar' and actor_role = 'moderator')
          and exists (select 1 from app.audit_log where action = 'banca_esgotada'), 'pagar e esgotar vão para a auditoria');

-- 7. Banimento a partir do pedido ------------------------------------------------------
do $$ begin perform pg_temp.mod1(); end $$;
select throws_ok($$ select api.staff_ban('00000000-0000-0000-0000-0000000000c1', 'ip', 'global', 'Fraude', null, null) $$, 'BP005', null,
  'ban de IP sem validade é recusado');
select throws_ok($$ select api.staff_ban('00000000-0000-0000-0000-0000000000c1', 'ip', 'global', 'Fraude', 200, null) $$, 'BP005', null,
  'ban de IP acima de 7 dias é recusado');
select ok((api.staff_ban('00000000-0000-0000-0000-0000000000c1', 'cpf', 'global', 'Comprovante falso', null, null) ->> 'ban') is not null,
  'Mod Um bane o CPF do pedido (global)');
select ok((api.staff_ban('00000000-0000-0000-0000-0000000000c1', 'ip', 'banca', 'Muitas tentativas', 24, null) ->> 'ban') is not null,
  'Mod Um bane o IP só nesta banca, por 24h');
reset role;
select is((select value_hmac from app.bans where kind = 'cpf'), pg_temp.h('cpf:9'), 'o ban usa o HMAC do pedido (ninguém digitou o CPF)');
select is((select status::text || '/' || refusal_reason::text from app.orders where id = '00000000-0000-0000-0000-0000000000c1'),
  'recusado/banido', 'pedido de origem pendente é recusado como banido');
set local role service_role;
select is(api.srv_viewer_state(pg_temp.h('sessao:9')), null, 'o link do pedido banido para de funcionar');
select is(pg_temp.pedido(gen_random_uuid(), 'atendime-0003', '9'), 'bloqueado', 'mesmo CPF em outra banca: bloqueado pelo ban global');
reset role;

do $$ begin perform pg_temp.mod1(); end $$;
select ok(not (api.staff_list_bans()::text ~ 'hmac|\\x'), 'lista de banidos não mostra o valor nem o HMAC');
reset role;
do $$ begin perform pg_temp.mod2(); end $$;
select throws_ok($$ select api.staff_lift_ban((select id from app.bans where kind = 'ip')) $$, '42501', null,
  'moderador NÃO desbane ban criado por outro');
reset role;
do $$ begin perform pg_temp.mod1(); end $$;
select throws_ok($$ select api.staff_lift_ban((select id from app.bans where kind = 'cpf')) $$, '42501', null,
  'moderador NÃO desbane ban GLOBAL, nem o próprio (D-014)');
select lives_ok($$ select api.staff_lift_ban((select id from app.bans where kind = 'ip')) $$,
  'moderador desbane o próprio ban DA BANCA');
reset role;
do $$ begin perform pg_temp.dono(); end $$;
select lives_ok($$ select api.staff_lift_ban((select id from app.bans where kind = 'cpf')) $$, 'streamer desbane o global');
reset role;

-- 8. Modo live e revelação ---------------------------------------------------------------
do $$ begin perform pg_temp.mod1(); end $$;
select is(api.staff_reveal('00000000-0000-0000-0000-0000000000c1', 'cpf', 'revelar'), 'v1:' || repeat('B', 32),
  'revelar devolve só aquele campo (cifrado, para o servidor)');
select throws_ok($$ select api.staff_reveal('00000000-0000-0000-0000-0000000000c1', 'cpf', 'copiar_pix') $$, 'BP005', null,
  '"copiar Pix" só vale para o campo Pix');
select ok(not api.staff_set_live_mode(false), 'moderador desliga o modo live');
select is((api.staff_list_queue((select id from app.bancas where code = 'atendime-0002')) ->> 'live')::boolean, false,
  'a fila informa que o modo live está desligado nesta sessão');
reset role;
select ok(exists (select 1 from app.audit_log where action = 'revelar' and detail ->> 'campo' = 'cpf')
          and exists (select 1 from app.audit_log where action = 'modo_live_off'), 'revelar e desligar o modo live são auditados');

-- 9. Respostas rápidas -----------------------------------------------------------------
do $$ begin perform pg_temp.mod1(); end $$;
select ok((select count(*) from api.staff_list_quick_replies()) >= 3, 'moderador usa as respostas rápidas');
select throws_ok($$ select api.owner_save_quick_reply(null, 'X', 'Y', 1) $$, '42501', null, 'moderador NÃO edita respostas rápidas');
reset role;
do $$ begin perform pg_temp.dono(); end $$;
select ok(api.owner_save_quick_reply(null, 'Aguarde', 'Já já te chamo.', 5) is not null, 'streamer cria resposta rápida');
reset role;

select * from finish();
rollback;
