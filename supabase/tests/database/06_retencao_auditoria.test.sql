-- Retenção da auditoria: apaga só o que passou de 12 meses e mantém a cadeia verificável.
begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

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

-- Dois eventos antigos (13 meses) e um recente, nessa ordem de inserção.
insert into app.audit_log (at, actor_role, action) values
  (now() - interval '13 months', 'sistema', 'evento_antigo'),
  (now() - interval '13 months' + interval '1 minute', 'sistema', 'evento_antigo');
insert into app.audit_log (actor_role, action) values ('sistema', 'evento_recente');

select is(app.audit_verify(), null::bigint, 'cadeia íntegra antes da retenção');
select is(app.purge_audit_log(), 2, 'retenção apaga os 2 eventos com mais de 12 meses');
select is((select array_agg(action) from app.audit_log), array['evento_recente'], 'o evento recente continua');
select is((select last_purged_pos from app.audit_anchor), 2::bigint, 'âncora guarda a posição do último apagado');
select is(app.audit_verify(), null::bigint, 'cadeia continua verificável a partir da âncora');
select is(app.purge_audit_log(), 0, 'rodar de novo não apaga nada');

-- Linha "antiga" inserida DEPOIS de uma recente não pode puxar a recente junto.
insert into app.audit_log (at, actor_role, action) values (now() - interval '2 years', 'sistema', 'fora_de_ordem');
select is(app.purge_audit_log(), 0, 'nada recente é apagado por causa de uma linha antiga fora de ordem');
select is((select count(*)::int from app.audit_log where action = 'evento_recente'), 1, 'o evento recente continua lá');

select * from finish();
rollback;
