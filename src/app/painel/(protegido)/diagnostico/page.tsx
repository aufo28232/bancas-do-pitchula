import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getServerEnv } from "@/lib/env";
import { configAccess } from "@/lib/server/cf-access";
import { ipDoCliente, saltosConfiaveis } from "@/lib/server/ip";
import { staffAtual } from "@/lib/server/painel/rsc";

export const metadata: Metadata = { title: "Diagnóstico" };

/**
 * Diagnóstico do deploy (só o streamer): mostra como o servidor está enxergando o
 * SEU próprio acesso, para acertar DEPLOY_MODE e TRUSTED_PROXY_HOPS (D-078).
 * Não mostra dados de ninguém além de quem está olhando.
 */
export default async function PaginaDiagnostico() {
  const staff = await staffAtual();
  if (!staff) redirect("/painel/entrar");
  if (staff.role !== "owner") notFound();
  const h = await headers();
  const { DEPLOY_MODE } = getServerEnv();
  const xff = (h.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const linhas: [string, string][] = [
    ["Modo de deploy (DEPLOY_MODE)", DEPLOY_MODE],
    ["Proxies confiáveis (TRUSTED_PROXY_HOPS)", String(saltosConfiaveis())],
    ["Valores em X-Forwarded-For", String(xff.length)],
    ["CF-Connecting-IP presente", h.get("cf-connecting-ip") ? "sim" : "não"],
    ["Cloudflare Access no painel", configAccess() ? "ligado (JWT conferido)" : "desligado"],
    ["Seu IP, como as regras por IP enxergam", ipDoCliente(h, DEPLOY_MODE)],
  ];
  return (
    <section className="flex flex-col gap-6">
      <h1 className="font-display text-5xl font-black uppercase leading-none">Diagnóstico</h1>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
        {linhas.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-muted">{k}</dt>
            <dd className="font-mono">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="max-w-2xl text-sm text-fg-muted">
        <p>
          Confira se &quot;Seu IP&quot; bate com o IP que aparece em sites como &quot;qual é meu IP&quot; no seu celular ou computador.
          Se não bater no modo <code>managed</code>, ajuste <code>TRUSTED_PROXY_HOPS</code> (veja o README).
        </p>
      </div>
    </section>
  );
}
