-- Estrutura: schemas, tabelas esperadas e RLS ligado em 100% das tabelas.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

select has_schema('app', 'schema app existe');
select has_schema('api', 'schema api existe');

select tables_are(
  'app',
  array[
    'staff', 'staff_invites', 'known_devices', 'staff_sessions', 'security_alerts',
    'bancas', 'banca_stats', 'orders', 'order_sessions', 'order_attachments', 'order_messages',
    'storage_purge_queue', 'bans', 'quick_replies', 'idempotency_keys', 'audit_log', 'audit_anchor'
  ],
  'app contém exatamente as tabelas do modelo'
);

select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0,
  'RLS ligado em todas as tabelas de app'
);

select is(
  (select count(*)::int
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'api' and c.relkind in ('r', 'p', 'v', 'm', 'f')),
  0,
  'api não contém tabelas nem views (só funções)'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'app' and roles @> array['anon']::name[]),
  0,
  'nenhuma política RLS concede nada ao papel anon'
);

select * from finish();
rollback;
