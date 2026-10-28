"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { enviar } from "@/lib/client/api";

/** Botão que faz um POST, pede confirmação quando a ação é sensível e recarrega os dados. */
export function BotaoAcao({
  url,
  corpo,
  rotulo,
  confirmar,
  variante = "secundario",
}: {
  url: string;
  corpo: Record<string, string>;
  rotulo: string;
  confirmar?: string;
  variante?: "secundario" | "perigo";
}) {
  const router = useRouter();
  const [etapa, setEtapa] = useState<"inicial" | "confirmando" | "enviando">("inicial");
  const [erro, setErro] = useState("");

  async function executar() {
    setEtapa("enviando");
    setErro("");
    const r = await enviar<{ proximo?: string }>(url, corpo);
    if (r.ok) {
      if (r.dados.proximo) router.replace(r.dados.proximo);
      router.refresh();
      setEtapa("inicial");
      return;
    }
    setErro(r.erro);
    setEtapa("inicial");
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {etapa === "confirmando" ? (
        <>
          <span className="text-sm text-fg-muted">{confirmar}</span>
          <Botao type="button" variante="perigo" onClick={executar}>
            Confirmar
          </Botao>
          <Botao type="button" variante="secundario" onClick={() => setEtapa("inicial")}>
            Cancelar
          </Botao>
        </>
      ) : (
        <Botao
          type="button"
          variante={variante}
          carregando={etapa === "enviando"}
          onClick={() => (confirmar ? setEtapa("confirmando") : executar())}
        >
          {rotulo}
        </Botao>
      )}
      {erro ? (
        <span role="alert" className="text-sm text-accent">
          {erro}
        </span>
      ) : null}
    </span>
  );
}

export function BotaoSair() {
  return <BotaoAcao url="/api/painel/auth/sair" corpo={{}} rotulo="Sair" />;
}

/** Criação de convite: o link aparece UMA vez, com botão de copiar. */
export function FormCriarConvite() {
  const router = useRouter();
  const [link, setLink] = useState("");
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [copiado, setCopiado] = useState(false);

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setEnviando(true);
    setErro("");
    const r = await enviar<{ link: string }>("/api/painel/convites/criar", {
      apelido: String(new FormData(form).get("apelido") ?? ""),
    });
    setEnviando(false);
    if (r.ok) {
      setLink(r.dados.link);
      setCopiado(false);
      form.reset();
      router.refresh();
    } else {
      setErro(r.erro);
    }
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(link);
      setCopiado(true);
    } catch {
      setCopiado(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={aoEnviar} className="flex flex-col gap-4 sm:flex-row sm:items-end" noValidate>
        <div className="flex-1">
          <Campo id="apelido-convite" name="apelido" rotulo="Apelido do novo moderador" maxLength={32} required />
        </div>
        <Botao carregando={enviando} className="sm:w-auto">
          Gerar convite
        </Botao>
      </form>
      <p role="alert" className="min-h-5 text-sm text-accent">
        {erro}
      </p>
      {link ? (
        <div className="flex flex-col gap-2 border border-line p-4">
          <p className="text-sm text-fg-muted">
            Link de uso único, válido por 24h. Ele só aparece agora: mande direto para a pessoa, nunca na live.
          </p>
          <code className="break-all font-mono text-sm">{link}</code>
          <div>
            <Botao type="button" variante="secundario" onClick={copiar}>
              {copiado ? "Copiado" : "Copiar link"}
            </Botao>
          </div>
        </div>
      ) : null}
    </div>
  );
}
