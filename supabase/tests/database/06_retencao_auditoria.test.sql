-- Retenção da auditoria: apaga só o que passou de 12 meses e mantém a cadeia verificável.
begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

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

select * from finish();
rollback;
