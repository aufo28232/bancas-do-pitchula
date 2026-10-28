-- RLS testada com cada identidade e nível de autenticação.
-- Objetivo: provar que o acesso é NEGADO, não só que a política existe.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- Identidades --------------------------------------------------------------
-- a1 owner · a2 moderador · a3 moderador desativado · a4 espectador anônimo
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod@teste.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'ex-mod@teste.local'),
  ('00000000-0000-0000-0000-0000000000a4', null);

insert into app.staff (user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', 'Pitchula'),
  ('00000000-0000-0000-0000-0000000000a2', 'moderator', 'Mod Um');
insert into app.staff (user_id, role, display_name, active, deactivated_at) values
  ('00000000-0000-0000-0000-0000000000a3', 'moderator', 'Mod Antigo', false, now());

-- Sessões do Supabase Auth (s5 de propósito NÃO existe aqui: sessão apagada/revogada no Auth)
insert into auth.sessions (id, user_id) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000a2'),
  ('00000000-0000-0000-0000-00000000005f', '00000000-0000-0000-0000-0000000000a3'),
  ('00000000-0000-0000-0000-000000000057', '00000000-0000-0000-0000-0000000000a4');

insert into app.staff_sessions (session_id, user_id, last_seen_at, revoked_at) values
  ('00000000-0000-0000-0000-00000000005a', '00000000-0000-0000-0000-0000000000a1', now(), null),                 -- owner ok
  ('00000000-0000-0000-0000-00000000005b', '00000000-0000-0000-0000-0000000000a2', now(), null),                 -- mod ok
  ('00000000-0000-0000-0000-00000000005c', '00000000-0000-0000-0000-0000000000a2', now(), now()),               -- revogada
  ('00000000-0000-0000-0000-00000000005d', '00000000-0000-0000-0000-0000000000a2', now() - interval '9 hours', null), -- inativa > 8h
  ('00000000-0000-0000-0000-00000000005e', '00000000-0000-0000-0000-0000000000a2', now(), null),                 -- sem auth.sessions
  ('00000000-0000-0000-0000-00000000005f', '00000000-0000-0000-0000-0000000000a3', now(), null);                 -- staff desativado

-- Dados ------------------------------------------------------------------
insert into app.bancas (id, code, name, total_cents, slots, created_by) values
  ('00000000-0000-0000-0000-0000000000b1', 'rlsteste-0001', 'Banca RLS', 300000, 100, '00000000-0000-0000-0000-0000000000a1');

insert into app.orders (id, banca_id, full_name_enc, cpf_enc, pix_type, pix_key_enc, platform_id_enc,
                        cpf_hmac, pix_hmac, platform_id_hmac, ip_hmac, hmac_key_version, ip_unique, access_token_hash, viewer_uid)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1',
        'v1:' || repeat('A', 32), 'v1:' || repeat('B', 32), 'cpf', 'v1:' || repeat('C', 32), 'v1:' || repeat('D', 32),
        sha256('\x01'), sha256('\x02'), sha256('\x03'), sha256('\x04'), 1, true, sha256('\x05'),
        '00000000-0000-0000-0000-0000000000a4');

insert into app.staff_invites (token_hash, display_name, created_by, expires_at)
values (sha256('\x06'), 'Novo Mod', '00000000-0000-0000-0000-0000000000a1', now() + interval '1 hour');

do $$ begin
  perform app.audit('banca_criar', '00000000-0000-0000-0000-0000000000a1', 'owner', '00000000-0000-0000-0000-0000000000b1');
end $$;

-- Troca de identidade: papel authenticated + claims do JWT.
create function pg_temp.como(p_uid text, p_session text, p_aal text, p_anon boolean default false)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object(
    'sub', p_uid, 'role', 'authenticated', 'aal', p_aal,
    'session_id', p_session, 'is_anonymous', p_anon)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

-- Owner AAL2 ---------------------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000005a', 'aal2'); end $$;
select is((select count(id)::int from app.bancas), 1, 'owner AAL2 vê as bancas');
select ok((select count(id) from app.audit_log) >= 1, 'owner AAL2 vê a auditoria');
select is((select count(session_id)::int from app.staff_sessions), 6, 'owner AAL2 vê as sessões de todos');
select is((select count(id)::int from app.staff_invites), 1, 'owner AAL2 vê os convites');
select throws_ok($$ delete from app.audit_log $$, '42501', null, 'owner NÃO consegue apagar a auditoria');
select throws_ok($$ select app.purge_audit_log() $$, '42501', null, 'owner NÃO executa a rotina de retenção da auditoria');
reset role;

-- Moderador AAL2 válido ------------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b', 'aal2'); end $$;
select is((select count(id)::int from app.bancas), 1, 'moderador AAL2 vê as bancas');
select is((select count(id)::int from app.orders), 1, 'moderador AAL2 vê os pedidos');
select is((select count(id)::int from app.audit_log), 0, 'moderador NÃO vê a auditoria');
select is((select count(id)::int from app.staff_invites), 0, 'moderador NÃO vê convites');
select is((select count(session_id)::int from app.staff_sessions), 4, 'moderador vê só as próprias sessões');
select throws_ok($$ select access_token_hash from app.orders $$, '42501', null, 'moderador NÃO lê o hash do token do pedido');
select throws_ok($$ insert into app.bancas (code, name, total_cents, slots, created_by)
                    values ('modcriou-0001', 'x', 100, 1, '00000000-0000-0000-0000-0000000000a2') $$,
                 '42501', null, 'moderador NÃO cria banca direto na tabela');
select throws_ok($$ update app.orders set status = 'pago' $$, '42501', null, 'moderador NÃO altera pedido direto na tabela');
select throws_ok($$ select app.audit('x_teste', null, 'sistema') $$, '42501', null, 'moderador NÃO grava auditoria direto');
reset role;

-- Negações por sessão / nível --------------------------------------------------
do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005b', 'aal1'); end $$;
select is((select count(id)::int from app.bancas), 0, 'moderador em AAL1 (sem MFA) não vê nada');
reset role;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005c', 'aal2'); end $$;
select is((select count(id)::int from app.bancas), 0, 'sessão revogada não vê nada, mesmo com JWT válido');
reset role;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005d', 'aal2'); end $$;
select is((select count(id)::int from app.bancas), 0, 'sessão inativa há mais de 8h não vê nada');
reset role;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000005e', 'aal2'); end $$;
select is((select count(id)::int from app.bancas), 0, 'sessão apagada no Supabase Auth não vê nada');
reset role;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-00000000005f', 'aal2'); end $$;
select is((select count(id)::int from app.bancas), 0, 'moderador removido (desativado) não vê nada com JWT ainda válido');
reset role;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000057', 'aal1', true); end $$;
select is((select count(id)::int from app.orders), 0, 'espectador anônimo não lê pedidos (nem o próprio) na tabela');
reset role;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000057', 'aal2', true); end $$;
select is((select count(id)::int from app.orders), 0, 'anônimo com aal2 forjado continua sem acesso');
reset role;

do $$ begin perform pg_temp.como('00000000-0000-0000-0000-0000000000a2', 'nao-e-uuid', 'aal2'); end $$;
select is((select count(id)::int from app.bancas), 0, 'session_id malformado: nega sem erro');
reset role;

do $$ begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'authenticated', true);
end $$;
select is((select count(id)::int from app.bancas), 0, 'authenticated sem JWT não vê nada');
reset role;

set local role anon;
select throws_ok($$ select 1 from app.bancas $$, '42501', null, 'papel anon não acessa o schema app');
reset role;

select * from finish();
rollback;
