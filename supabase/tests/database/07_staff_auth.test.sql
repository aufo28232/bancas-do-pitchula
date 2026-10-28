-- Etapa 2: funções de staff, convites, sessões e equipe.
-- Prova que cada operação é NEGADA para quem não pode, mesmo chamando o banco direto.
begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

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

-- Identidades ------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod@teste.local'),
  ('00000000-0000-0000-0000-0000000000a4', null),
  ('00000000-0000-0000-0000-0000000000a5', 'novo-mod@teste.local'),
  ('00000000-0000-0000-0000-0000000000a6', 'intruso@teste.local'),
  ('00000000-0000-0000-0000-0000000000a7', 'nao-staff@teste.local');

insert into app.staff (user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', 'Pitchula'),
  ('00000000-0000-0000-0000-0000000000a2', 'moderator', 'Mod Um');

insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-000000000057', '00000000-0000-0000-0000-0000000000a4'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-000000000072', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-000000000073', '00000000-0000-0000-0000-0000000000a7');

insert into app.staff_sessions (session_id, user_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000a2');

create function pg_temp.como(p_uid text, p_session text, p_aal text, p_anon boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', p_aal,
    'session_id', p_session, 'is_anonymous', p_anon)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- 1. Visitante sem login (anon) --------------------------------------------
set local role anon;
select throws_ok($$ select api.owner_create_invite(sha256('\x01'), 'X') $$, '42501', null,
  'anon não executa funções do painel');
reset role;

-- 2. Espectador anônimo (authenticated + is_anonymous) ---------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000057', 'aal2', true); end $$;
select throws_ok($$ select * from api.staff_whoami() $$, '42501', null, 'espectador anônimo não é staff');
select throws_ok($$ select * from api.preauth_whoami() $$, '42501', null, 'espectador anônimo não passa nem do pré-MFA');
reset role;

-- 3. Moderador em AAL1 (sem MFA) -------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b', 'aal1'); end $$;
select throws_ok($$ select * from api.staff_whoami() $$, '42501', null, 'moderador em AAL1 não acessa o painel');
select throws_ok($$ select * from api.staff_list_sessions() $$, '42501', null, 'moderador em AAL1 não lista sessões');
select is((select count(*)::int from api.preauth_whoami()), 1, 'moderador em AAL1 só passa no pré-MFA (para cadastrar/verificar o TOTP)');
reset role;

-- Logout encerra só a sessão do próprio JWT (sem parâmetro que permita escolher outra).
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005d', 'aal1'); end $$;
select lives_ok($$ select api.preauth_end_session() $$, 'logout funciona até em AAL1');
reset role;
select is((select count(*)::int from auth.sessions where id = '00000000-0000-0000-0000-00000000005d'), 0,
  'logout apaga a sessão no Supabase Auth');

-- 4. Moderador AAL2: pode o que é dele, não o que é do streamer -------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b', 'aal2'); end $$;
select is((select role::text from api.staff_whoami()), 'moderator', 'moderador AAL2 entra no painel');
select throws_ok($$ select api.owner_create_invite(sha256('\x02'), 'Outro') $$, '42501', null, 'moderador NÃO cria convite');
select throws_ok($$ select * from api.owner_list_staff() $$, '42501', null, 'moderador NÃO lista a equipe');
select throws_ok($$ select api.owner_deactivate_staff('00000000-0000-0000-0000-0000000000a1') $$, '42501', null, 'moderador NÃO remove ninguém');
select throws_ok($$ select api.owner_prepare_mfa_reset('00000000-0000-0000-0000-0000000000a1') $$, '42501', null, 'moderador NÃO reseta MFA');
select throws_ok($$ select api.staff_revoke_session('00000000-0000-0000-0000-00000000005a') $$, '42501', null, 'moderador NÃO derruba sessão do streamer');
select throws_ok($$ select api.srv_consume_invite(sha256('\x02'), '00000000-0000-0000-0000-0000000000a2', 'x') $$, '42501', null, 'staff NÃO chama funções exclusivas do servidor');
select lives_ok($$ select api.staff_revoke_session('00000000-0000-0000-0000-00000000005c') $$, 'moderador derruba a própria sessão');
reset role;

select is((select count(*)::int from auth.sessions where id = '00000000-0000-0000-0000-00000000005c'), 0,
  'sessão revogada é apagada também no Supabase Auth (refresh token morre junto)');

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005c', 'aal2'); end $$;
select throws_ok($$ select * from api.staff_whoami() $$, '42501', null, 'JWT ainda válido de sessão revogada é recusado');
reset role;

-- 5. Convites -------------------------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a', 'aal2'); end $$;
select lives_ok($$ select api.owner_create_invite(sha256(convert_to('convite-bom', 'UTF8')), 'Novo Mod') $$, 'streamer cria convite');
reset role;
select is((select expires_at - created_at from app.staff_invites where display_name = 'Novo Mod'), interval '24 hours',
  'convite expira em 24h');

set local role service_role;
select is((select count(*)::int from api.srv_check_invite(sha256(convert_to('convite-bom', 'UTF8')))), 1, 'convite válido é reconhecido');
select ok(api.srv_consume_invite(sha256(convert_to('convite-bom', 'UTF8')), '00000000-0000-0000-0000-0000000000a5', 'Novo Mod'),
  'convite válido cria o moderador');
select ok(not api.srv_consume_invite(sha256(convert_to('convite-bom', 'UTF8')), '00000000-0000-0000-0000-0000000000a6', 'Intruso'),
  'convite já usado NÃO cria segunda conta');
reset role;
select is((select role::text from app.staff where user_id = '00000000-0000-0000-0000-0000000000a5'), 'moderator', 'quem aceitou vira moderador (nunca owner)');
select is((select count(*)::int from app.staff where user_id = '00000000-0000-0000-0000-0000000000a6'), 0, 'o segundo usuário não virou staff');

-- Expirado (criado há 25h, expirou há 1h)
insert into app.staff_invites (token_hash, display_name, created_by, created_at, expires_at)
values (sha256(convert_to('convite-velho', 'UTF8')), 'Velho', '00000000-0000-0000-0000-0000000000a1',
        now() - interval '25 hours', now() - interval '1 hour');
-- Revogado
insert into app.staff_invites (token_hash, display_name, created_by, expires_at, revoked_at)
values (sha256(convert_to('convite-revogado', 'UTF8')), 'Revogado', '00000000-0000-0000-0000-0000000000a1',
        now() + interval '1 hour', now());

set local role service_role;
select ok(not api.srv_consume_invite(sha256(convert_to('convite-velho', 'UTF8')), '00000000-0000-0000-0000-0000000000a6', 'X'),
  'convite expirado é recusado');
select ok(not api.srv_consume_invite(sha256(convert_to('convite-revogado', 'UTF8')), '00000000-0000-0000-0000-0000000000a6', 'X'),
  'convite revogado é recusado');

-- 6. Registro de sessão no login ------------------------------------------------------
select is((select count(*)::int from api.srv_register_staff_session(
  '00000000-0000-0000-0000-0000000000a7', '00000000-0000-0000-0000-000000000073', sha256('\x0a'), 'Chrome', null)), 0,
  'login de quem não é staff não registra sessão');
select is((select novo_dispositivo from api.srv_register_staff_session(
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000071', sha256('\x0b'), 'Chrome · Windows', 'BR')), true,
  'primeiro dispositivo é registrado');
select is((select novo_dispositivo from api.srv_register_staff_session(
  '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000072', sha256('\x0c'), 'Safari · iOS', 'BR')), true,
  'segundo dispositivo é reconhecido como novo');
reset role;
select is((select count(*)::int from app.security_alerts where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'novo_dispositivo'), 1,
  'login em dispositivo novo gera alerta para o streamer');

-- 7. Reset de MFA e remoção de moderador ------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a', 'aal2'); end $$;
select throws_ok($$ select api.owner_prepare_mfa_reset('00000000-0000-0000-0000-0000000000a1') $$, '22023', null,
  'streamer não reseta o próprio MFA pelo painel (recuperação manual)');
select lives_ok($$ select api.owner_prepare_mfa_reset('00000000-0000-0000-0000-0000000000a5') $$, 'streamer autoriza reset de MFA de moderador');
select lives_ok($$ select api.owner_deactivate_staff('00000000-0000-0000-0000-0000000000a2') $$, 'streamer remove o moderador');
reset role;
select is((select count(*)::int from app.audit_log
            where action = 'mfa_reset' and target_user_id = '00000000-0000-0000-0000-0000000000a5'), 1,
  'reset de MFA fica registrado na auditoria');

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b', 'aal2'); end $$;
select throws_ok($$ select * from api.staff_whoami() $$, '42501', null, 'moderador removido perde o acesso na próxima requisição, mesmo com JWT válido');
reset role;

select * from finish();
rollback;
