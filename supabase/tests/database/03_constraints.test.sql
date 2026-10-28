-- Constraints de negócio garantidas pelo banco (não só pela aplicação).
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Fixtures ---------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'outro-owner@teste.local');

insert into app.staff (user_id, role, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner', 'Pitchula');

create function pg_temp.h(p text) returns bytea language sql immutable as $$ select sha256(convert_to(p, 'UTF8')) $$;
create function pg_temp.enc() returns text language sql as $$ select 'v1:' || repeat('A', 32) $$;

create function pg_temp.banca(p_code text, p_total bigint default 300000, p_slots int default 100)
returns uuid language sql as $$
  insert into app.bancas (code, name, total_cents, slots, created_by)
  values (p_code, 'Banca teste', p_total, p_slots, '00000000-0000-0000-0000-0000000000a1')
  returning id
$$;

create function pg_temp.pedido(p_banca uuid, p_cpf text, p_ip text, p_ip_unique boolean)
returns uuid language sql as $$
  insert into app.orders (id, banca_id, full_name_enc, cpf_enc, pix_type, pix_key_enc, platform_id_enc,
                          cpf_hmac, pix_hmac, platform_id_hmac, ip_hmac, hmac_key_version, ip_unique, access_token_hash)
  values (gen_random_uuid(), p_banca, pg_temp.enc(), pg_temp.enc(), 'cpf', pg_temp.enc(), pg_temp.enc(),
          pg_temp.h('cpf:' || p_cpf), pg_temp.h('pix:' || p_cpf), pg_temp.h('pid:' || p_cpf), pg_temp.h('ip:' || p_ip),
          1, p_ip_unique, pg_temp.h(gen_random_uuid()::text))
  returning id
$$;

-- Staff ------------------------------------------------------------------
select throws_ok(
  $$ insert into app.staff (user_id, role, display_name) values ('00000000-0000-0000-0000-0000000000a2', 'owner', 'Outro') $$,
  '23505', null, 'só pode existir um owner ativo'
);

select throws_ok(
  $$ insert into app.staff (user_id, role, display_name) values ('00000000-0000-0000-0000-0000000000a2', 'moderator', '<script>') $$,
  '23514', null, 'apelido com caracteres proibidos é recusado'
);

-- Bancas: valores ----------------------------------------------------------
do $$ begin perform pg_temp.banca('aaaaaaa1-0001', 10000, 3); end $$;

select is(
  (select per_person_cents from app.bancas where code = 'aaaaaaa1-0001'),
  3333::bigint,
  'R$ 100 ÷ 3 = R$ 33,33 por pessoa (arredonda para baixo)'
);

select is(
  (select remainder_cents from app.bancas where code = 'aaaaaaa1-0001'),
  1::bigint,
  'sobra de R$ 0,01 fica registrada'
);

do $$ begin perform pg_temp.banca('aaaaaaa2-0002', 300000, 100); end $$;
select is(
  (select (per_person_cents, remainder_cents)::text from app.bancas where code = 'aaaaaaa2-0002'),
  '(3000,0)',
  'R$ 3.000 ÷ 100 = R$ 30,00 sem sobra'
);

select throws_ok($$ select pg_temp.banca('aaaaaaa3-0003', 50, 100) $$, '23514', null,
  'valor total menor que o número de vagas é recusado (R$ 0,00 por pessoa)');

select throws_ok($$ select pg_temp.banca('aaaaaaa4-0004', 100000001, 10) $$, '23514', null,
  'valor acima do teto do banco é recusado');

select throws_ok($$ select pg_temp.banca('AAAA-12', 1000, 1) $$, '23514', null,
  'código fora do formato é recusado');

select throws_ok($$ select pg_temp.banca('aaaaaaa5-0005', 1000, 0) $$, '23514', null,
  'banca com zero vagas é recusada');

-- Bancas: estados -----------------------------------------------------------
select throws_ok(
  $$ update app.bancas set paid_count = 101 where code = 'aaaaaaa2-0002' $$,
  '23514', null, 'pagos não podem passar do número de vagas'
);

select throws_ok(
  $$ update app.bancas set status = 'esgotada', sold_out_at = now() where code = 'aaaaaaa2-0002' $$,
  '23514', null, 'esgotada exige pagos = vagas'
);

select throws_ok(
  $$ update app.bancas set status = 'encerrada', ended_at = now() where code = 'aaaaaaa2-0002' $$,
  '23514', null, 'encerrada exige que o link (código) seja apagado'
);

select throws_ok(
  $$ update app.bancas set code = 'bbbbbbbb-9999' where code = 'aaaaaaa2-0002' $$,
  '55000', null, 'o código só pode ser removido, nunca trocado'
);

select lives_ok(
  $$ update app.bancas set status = 'encerrada', ended_at = now(), code = null where code = 'aaaaaaa1-0001' $$,
  'encerrar apagando o código funciona'
);

select throws_ok(
  $$ select pg_temp.banca('aaaaaaa1-0001', 1000, 1) $$,
  '23505', null, 'código de banca encerrada nunca é reaproveitado'
);

-- Pedidos: anti-duplicidade -------------------------------------------------
create temp table t_ids as select pg_temp.banca('ccccccc1-0001', 300000, 100) as banca_ip,
                                  pg_temp.banca('ccccccc2-0002', 300000, 100) as banca_sem_ip;

select lives_ok($$ select pg_temp.pedido((select banca_ip from t_ids), '11111111111', '10.0.0.1', true) $$,
  'primeiro pedido entra');

select throws_ok($$ select pg_temp.pedido((select banca_ip from t_ids), '11111111111', '10.0.0.2', true) $$,
  '23505', null, 'mesmo CPF na mesma banca é barrado pelo banco');

select throws_ok($$ select pg_temp.pedido((select banca_ip from t_ids), '22222222222', '10.0.0.1', true) $$,
  '23505', null, 'mesmo IP na mesma banca é barrado quando a regra está ligada');

select lives_ok($$
  select pg_temp.pedido((select banca_sem_ip from t_ids), '33333333333', '10.0.0.9', false);
  select pg_temp.pedido((select banca_sem_ip from t_ids), '44444444444', '10.0.0.9', false);
$$, 'mesmo IP é aceito quando a regra está desligada');

select throws_ok($$
  update app.orders set status = 'pago' where banca_id = (select banca_ip from t_ids)
$$, '23514', null, 'pago sem quem pagou e quando é recusado');

select throws_ok($$
  insert into app.orders (id, banca_id, full_name_enc, cpf_enc, pix_type, pix_key_enc, platform_id_enc,
                          cpf_hmac, pix_hmac, platform_id_hmac, ip_hmac, hmac_key_version, ip_unique, access_token_hash)
  values (gen_random_uuid(), (select banca_sem_ip from t_ids), 'Fulano de Tal', pg_temp.enc(), 'cpf', pg_temp.enc(), pg_temp.enc(),
          pg_temp.h('a'), pg_temp.h('b'), pg_temp.h('c'), pg_temp.h('d'), 1, false, pg_temp.h('e'))
$$, '23514', null, 'nome em texto puro (não cifrado) é recusado pelo banco');

-- Banimentos -------------------------------------------------------------
select throws_ok($$
  insert into app.bans (kind, value_hmac, hmac_key_version, scope, reason, created_by, expires_at)
  values ('ip', pg_temp.h('ip:1'), 1, 'global', 'flood', '00000000-0000-0000-0000-0000000000a1', now() + interval '8 days')
$$, '23514', null, 'ban de IP com mais de 7 dias é impossível');

select throws_ok($$
  insert into app.bans (kind, value_hmac, hmac_key_version, scope, reason, created_by)
  values ('ip', pg_temp.h('ip:1'), 1, 'global', 'flood', '00000000-0000-0000-0000-0000000000a1')
$$, '23514', null, 'ban de IP sem expiração é impossível');

-- Convites ---------------------------------------------------------------
select throws_ok($$
  insert into app.staff_invites (token_hash, display_name, created_by, expires_at)
  values (pg_temp.h('convite'), 'Mod', '00000000-0000-0000-0000-0000000000a1', now() + interval '25 hours')
$$, '23514', null, 'convite com validade acima de 24h é recusado');

select * from finish();
rollback;
