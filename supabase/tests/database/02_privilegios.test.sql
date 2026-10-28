-- Privilégios: prova que anon/service_role não têm NADA nas tabelas de app,
-- que authenticated só tem SELECT (filtrado por RLS) e que segredos de coluna não são legíveis.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

-- Tabelas de app, para reuso nas consultas abaixo.
create temp view t_app as
  select c.oid, c.relname
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p');

select is_empty(
  $$ select relname from t_app
     where has_table_privilege('anon', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        or has_any_column_privilege('anon', oid, 'SELECT, INSERT, UPDATE, REFERENCES') $$,
  'anon: nenhum privilégio em nenhuma tabela de app'
);

select is_empty(
  $$ select relname from t_app
     where has_table_privilege('service_role', oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        or has_any_column_privilege('service_role', oid, 'SELECT, INSERT, UPDATE, REFERENCES') $$,
  'service_role: nenhum privilégio direto em tabelas de app (só via funções)'
);

select is_empty(
  $$ select relname from t_app
     where has_table_privilege('authenticated', oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        or has_any_column_privilege('authenticated', oid, 'INSERT, UPDATE, REFERENCES') $$,
  'authenticated: nenhuma escrita em nenhuma tabela de app'
);

select set_eq(
  $$ select relname::text from t_app where has_any_column_privilege('authenticated', oid, 'SELECT') $$,
  array[
    'staff', 'staff_invites', 'known_devices', 'staff_sessions', 'security_alerts',
    'bancas', 'banca_stats', 'orders', 'order_attachments', 'order_messages',
    'bans', 'quick_replies', 'audit_log', 'audit_anchor'
  ],
  'authenticated: SELECT só nas tabelas que o staff lê'
);

select ok(
  not has_column_privilege('authenticated', 'app.orders', 'access_token_hash', 'SELECT'),
  'hash do token do pedido não é legível por authenticated'
);

select ok(
  not has_column_privilege('authenticated', 'app.staff_invites', 'token_hash', 'SELECT'),
  'hash do token de convite não é legível por authenticated'
);

select is_empty(
  $$ select relname from t_app
     where relname in ('order_sessions', 'storage_purge_queue', 'idempotency_keys')
       and has_any_column_privilege('authenticated', oid, 'SELECT') $$,
  'sessões de pedido, fila de exclusão e idempotência: invisíveis para authenticated'
);

select is_empty(
  $$ select p.oid::regprocedure::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'api') and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  'anon não executa nenhuma função de app/api'
);

select set_eq(
  $$ select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'api') and has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  array['current_staff_role'],
  'authenticated só executa app.current_staff_role (usada pelas políticas)'
);

select ok(
  not has_schema_privilege('anon', 'app', 'USAGE'),
  'anon não tem USAGE no schema app'
);

select * from finish();
rollback;
