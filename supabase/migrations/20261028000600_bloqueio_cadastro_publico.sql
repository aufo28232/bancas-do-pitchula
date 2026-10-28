-- =====================================================================
-- Etapa 2 · Bloqueio de cadastro público NO BANCO (DECISIONS D-048, revisada)
--
-- Contexto: no Supabase Auth, desligar o cadastro por e-mail desliga também o
-- LOGIN por e-mail, e desligar o cadastro geral desliga o login anônimo do
-- espectador (D-003). Então o Auth fica com cadastro "ligado" e quem barra é o
-- Postgres: o Supabase Auth (papel supabase_auth_admin) só consegue criar
-- usuário NÃO anônimo se o servidor tiver pré-autorizado aquele e-mail há
-- menos de 10 minutos. Isso só acontece no seed do streamer e no aceite de
-- convite. Qualquer outra tentativa (POST /auth/v1/signup, por exemplo) falha.
-- =====================================================================

create table app.auth_provisioning (
  email_hash  bytea primary key,
  expires_at  timestamptz not null,
  constraint auth_provisioning_hash_ck check (octet_length(email_hash) = 32)
);
alter table app.auth_provisioning enable row level security;
revoke all on app.auth_provisioning from public, anon, authenticated, service_role;

create function app.email_hash(p_email text)
returns bytea
language sql
immutable
set search_path = ''
as $$ select sha256(convert_to(lower(btrim(p_email)), 'UTF8')) $$;

-- Servidor: autoriza a criação de UMA conta com este e-mail nos próximos 10 minutos.
create function api.srv_allow_account(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_email is null or position('@' in p_email) < 2 then
    raise exception 'e-mail inválido' using errcode = '22023';
  end if;
  delete from app.auth_provisioning where expires_at < now();
  insert into app.auth_provisioning (email_hash, expires_at)
  values (app.email_hash(p_email), now() + interval '10 minutes')
  on conflict (email_hash) do update set expires_at = excluded.expires_at;
end;
$$;

-- Consome a autorização (uso único). Chamada só pelo trigger abaixo.
create function app.consume_account_permission(p_email text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from app.auth_provisioning
   where email_hash = app.email_hash(p_email)
     and expires_at > now();
  return found;
end;
$$;

-- Trigger SECURITY INVOKER: current_user é quem está inserindo.
-- Só filtra o que vem do Supabase Auth; donos do banco (migrations, testes,
-- dashboard) não passam por aqui.
create function app.guard_auth_user_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'supabase_auth_admin' then
    return new;
  end if;
  -- Espectador: login anônimo (protegido por Turnstile e rate limit do Auth). Não acessa nenhuma tabela.
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;
  if new.email is not null and app.consume_account_permission(new.email) then
    return new;
  end if;
  raise exception 'cadastro público desativado' using errcode = '42501';
end;
$$;

create trigger bloqueia_cadastro_publico
  before insert on auth.users
  for each row execute function app.guard_auth_user_insert();

-- Privilégios mínimos para o papel do Auth executar o trigger.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant usage on schema app to supabase_auth_admin';
    execute 'grant execute on function app.guard_auth_user_insert() to supabase_auth_admin';
    execute 'grant execute on function app.consume_account_permission(text) to supabase_auth_admin';
  end if;
end;
$$;

revoke all on function api.srv_allow_account(text) from public, anon, authenticated;
grant execute on function api.srv_allow_account(text) to service_role;
revoke all on function app.email_hash(text) from public, anon, authenticated, service_role;
revoke all on function app.consume_account_permission(text) from public, anon, authenticated, service_role;
revoke all on function app.guard_auth_user_insert() from public, anon, authenticated, service_role;
