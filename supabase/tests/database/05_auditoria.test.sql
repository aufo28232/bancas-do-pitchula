-- Auditoria append-only: ninguém altera ou apaga; adulteração é detectável.
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1', 'owner@teste.local');
insert into app.staff (user_id, role, display_name) values ('00000000-0000-0000-0000-0000000000a1', 'owner', 'Pitchula');

do $$ begin
  perform app.audit('login', '00000000-0000-0000-0000-0000000000a1', 'owner');
  perform app.audit('banca_criar', '00000000-0000-0000-0000-0000000000a1', 'owner',
                    p_detail => '{"valor_cents": 300000, "vagas": 100}'::jsonb);
  perform app.audit('banca_encerrar', null, 'sistema', p_detail => '{"automatico": true}'::jsonb);
end $$;

select is((select count(*)::int from app.audit_log), 3, 'três eventos gravados');
select is(app.audit_verify(), null::bigint, 'cadeia de hash íntegra');
select is(
  (select array_agg(chain_pos order by chain_pos) from app.audit_log),
  array[1, 2, 3]::bigint[],
  'posições na cadeia são sequenciais'
);

-- Mesmo o dono do banco é barrado pelos triggers.
select throws_ok($$ update app.audit_log set action = 'outra_coisa' $$, '42501', null, 'UPDATE na auditoria é bloqueado');
select throws_ok($$ delete from app.audit_log $$, '42501', null, 'DELETE na auditoria é bloqueado');
select throws_ok($$ truncate app.audit_log $$, '42501', null, 'TRUNCATE na auditoria é bloqueado');

-- Detalhe só aceita chaves da lista permitida (nunca CPF, Pix, token...).
select throws_ok(
  $$ select app.audit('revelar', '00000000-0000-0000-0000-0000000000a1', 'owner', p_detail => '{"cpf": "12345678909"}'::jsonb) $$,
  '23514', null, 'chave fora da lista permitida em detail é recusada'
);
select throws_ok(
  $$ select app.audit('Ação Inválida!', '00000000-0000-0000-0000-0000000000a1', 'owner') $$,
  '23514', null, 'nome de ação fora do padrão é recusado'
);
select throws_ok(
  $$ select app.audit('login', null, 'owner') $$,
  '23514', null, 'evento de usuário sem autor é recusado'
);

-- Adulteração por quem desliga os triggers (dono/superusuário) é DETECTADA.
alter table app.audit_log disable trigger audit_log_no_update_delete;
update app.audit_log set detail = '{"valor_cents": 1}'::jsonb where chain_pos = 2;
alter table app.audit_log enable trigger audit_log_no_update_delete;
select is(app.audit_verify(), 2::bigint, 'alteração de uma linha antiga é detectada na posição exata');

alter table app.audit_log disable trigger audit_log_no_update_delete;
delete from app.audit_log where chain_pos = 2;
alter table app.audit_log enable trigger audit_log_no_update_delete;
select is(app.audit_verify(), 3::bigint, 'remoção de uma linha do meio é detectada');

-- O que foi lido acima não depende do papel: authenticated nem enxerga a tabela sem ser owner AAL2.
select ok(
  not has_table_privilege('authenticated', 'app.audit_log', 'INSERT, UPDATE, DELETE, TRUNCATE'),
  'authenticated não tem nenhum privilégio de escrita na auditoria'
);

select * from finish();
rollback;
