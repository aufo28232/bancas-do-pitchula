-- =====================================================================
-- Etapa 1 · Schemas e tipos
-- `app`: tabelas e funções internas. NÃO é exposto no PostgREST.
-- `api`: único schema exposto; terá só funções (etapas seguintes).
-- Ver ARCHITECTURE §3 e DECISIONS D-002.
-- =====================================================================

create schema if not exists app;
create schema if not exists api;

-- Ninguém além do dono recebe nada por padrão.
revoke all on schema app from public, anon, authenticated, service_role;
revoke all on schema api from public, anon, authenticated, service_role;

-- `authenticated` precisa de USAGE em `app` para as políticas RLS chamarem
-- app.current_staff_role(). As tabelas continuam sem grant (ver migração de RLS).
grant usage on schema app to authenticated;
grant usage on schema api to anon, authenticated, service_role;

alter default privileges in schema app revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema app revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema app revoke all on functions from public, anon, authenticated, service_role;
alter default privileges in schema api revoke all on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------
create type app.staff_role as enum ('owner', 'moderator');

create type app.banca_status as enum ('aberta', 'fechada', 'esgotada', 'encerrada');

-- "Em atendimento" não é estado: é pendente + trava ativa (D-006).
create type app.order_status as enum ('pendente', 'pago', 'recusado');

create type app.pix_key_type as enum ('cpf', 'email', 'telefone', 'aleatoria');

-- Encerrar apaga os pedidos na hora, por isso não há 'banca_encerrada' (D-044).
-- 'sem_resposta' = prazo de 5 min estourado (D-043).
create type app.refusal_reason as enum (
  'vagas_esgotadas',
  'banido',
  'sem_resposta',
  'comprovante_ilegivel',
  'deposito_nao_encontrado',
  'dados_divergentes',
  'exclusao_a_pedido',
  'outro'
);

create type app.ban_kind as enum ('cpf', 'pix', 'platform_id', 'ip');

create type app.ban_scope as enum ('global', 'banca');

create type app.msg_author as enum ('espectador', 'staff', 'sistema');

-- ---------------------------------------------------------------------
-- Utilitário: converte texto em uuid sem lançar erro (claims malformados).
-- ---------------------------------------------------------------------
create function app.try_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return p::uuid;
exception
  when invalid_text_representation then
    return null;
end;
$$;
