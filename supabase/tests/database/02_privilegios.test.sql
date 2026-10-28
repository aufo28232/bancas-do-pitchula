-- Privilégios: prova que anon/service_role não têm NADA nas tabelas de app,
-- que authenticated só tem SELECT (filtrado por RLS) e que segredos de coluna não são legíveis.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

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
  'authenticated: SELECT só nas tabelas que o staff lê (auth_provisioning fica de fora)'
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
  $$ select n.nspname || '.' || p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'api') and has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  array[
    'app.current_staff_role', 'app.viewer_owns_topic',
    'api.staff_whoami', 'api.preauth_whoami', 'api.preauth_end_session', 'api.staff_list_sessions', 'api.staff_revoke_session',
    'api.owner_list_alerts', 'api.owner_ack_alert', 'api.owner_list_staff', 'api.owner_deactivate_staff',
    'api.owner_prepare_mfa_reset', 'api.owner_create_invite', 'api.owner_revoke_invite', 'api.owner_list_invites',
    'api.owner_create_banca', 'api.owner_update_banca', 'api.owner_set_banca_status', 'api.staff_list_bancas',
    'api.staff_list_queue', 'api.staff_get_order', 'api.staff_claim', 'api.owner_force_claim', 'api.staff_release',
    'api.staff_send_message', 'api.staff_mark_paid', 'api.staff_refuse', 'api.staff_ban', 'api.staff_list_bans',
    'api.staff_lift_ban', 'api.staff_reveal', 'api.staff_set_live_mode', 'api.staff_list_quick_replies',
    'api.owner_save_quick_reply', 'api.owner_delete_quick_reply',
    'api.staff_attachment_path', 'api.staff_end_banca', 'api.owner_list_audit', 'api.owner_verify_audit',
    'api.staff_erase_order'
  ],
  'authenticated só executa as funções das políticas e as funções staff_/owner_/preauth_ (que conferem o papel por dentro)'
);

select set_eq(
  $$ select n.nspname || '.' || p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('app', 'api') and has_function_privilege('service_role', p.oid, 'EXECUTE') $$,
  array[
    'api.srv_register_staff_session', 'api.srv_login_failed',
    'api.srv_check_invite', 'api.srv_consume_invite', 'api.srv_seed_owner', 'api.srv_allow_account',
    'api.public_get_banca', 'api.public_create_order',
    'api.srv_open_order_session', 'api.srv_bind_viewer', 'api.srv_viewer_state', 'api.srv_viewer_post_message',
    'api.srv_viewer_add_attachment', 'api.srv_viewer_attachment_path', 'api.srv_viewer_delete',
    'api.srv_maintenance', 'api.srv_purge_batch', 'api.srv_purge_done'
  ],
  'service_role só executa as funções srv_ e public_ (nada de app.* direto)'
);

select ok(
  not has_schema_privilege('anon', 'app', 'USAGE'),
  'anon não tem USAGE no schema app'
);

select * from finish();
rollback;
