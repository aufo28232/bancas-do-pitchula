"use client";

import Link from "next/link";
import { useRef, useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { Turnstile } from "@/components/ui/turnstile";
import { enviar } from "@/lib/client/api";
import {
  mascaraCpf,
  mascaraTelefone,
  pedidoSchema,
  ROTULO_TIPO_PIX,
  TIPOS_PIX,
  type TipoPix,
} from "@/lib/validacao/pedido";

type Erros = Partial<Record<"nome" | "pixChave" | "plataformaId" | "cpf" | "privacidade" | "maioridade" | "turnstile", string>>;

const PLACEHOLDER_PIX: Record<TipoPix, string> = {
  cpf: "000.000.000-00",
  email: "voce@exemplo.com",
  telefone: "(00) 00000-0000",
  aleatoria: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
};

const ORDEM_CAMPOS = ["nome", "pixChave", "plataformaId", "cpf", "privacidade", "maioridade"] as const;

export function FormPedido({ codigo, siteKey, plataforma }: { codigo: string; siteKey: string; plataforma: string }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [tipoPix, setTipoPix] = useState<TipoPix>("cpf");
  const [pixChave, setPixChave] = useState("");
  const [cpf, setCpf] = useState("");
  const [turnstile, setTurnstile] = useState("");
  const [chaveTurnstile, setChaveTurnstile] = useState(0);
  const [erros, setErros] = useState<Erros>({});
  const [erroGeral, setErroGeral] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [link, setLink] = useState("");
  const [copiado, setCopiado] = useState(false);

  function aoMudarPix(valor: string) {
    setPixChave(tipoPix === "cpf" ? mascaraCpf(valor) : tipoPix === "telefone" ? mascaraTelefone(valor) : valor);
  }

  function trocarTipo(t: TipoPix) {
    setTipoPix(t);
    setPixChave("");
    setErros((e) => ({ ...e, pixChave: undefined }));
  }

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const dados = {
      codigo,
      nome: String(f.get("nome") ?? ""),
      pixTipo: tipoPix,
      pixChave,
      plataformaId: String(f.get("plataformaId") ?? ""),
      cpf,
      privacidade: f.get("privacidade") === "on",
      maioridade: f.get("maioridade") === "on",
      turnstile,
    };

    // Validação no navegador com o MESMO schema do servidor (feedback imediato).
    const r = pedidoSchema.safeParse(dados);
    if (!r.success) {
      const novos: Erros = {};
      for (const issue of r.error.issues) {
        const campo = issue.path[0] as keyof Erros;
        if (campo && !novos[campo]) novos[campo] = issue.message;
      }
      setErros(novos);
      setErroGeral(novos.turnstile ?? "Confira os campos destacados.");
      const primeiro = ORDEM_CAMPOS.find((c) => novos[c]);
      if (primeiro) formRef.current?.querySelector<HTMLElement>(`[name="${primeiro}"]`)?.focus();
      return;
    }

    setErros({});
    setErroGeral("");
    setEnviando(true);
    const resposta = await enviar<{ link: string }>("/api/bancas/pedido", dados);
    setEnviando(false);
    if (resposta.ok) {
      setLink(resposta.dados.link);
      return;
    }
    setErroGeral(resposta.erro);
    setTurnstile("");
    setChaveTurnstile((k) => k + 1); // token do Turnstile é de uso único
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(link);
      setCopiado(true);
    } catch {
      setCopiado(false);
    }
  }

  if (link) {
    return (
      <div role="status" className="flex flex-col gap-4 border-l-2 border-accent pl-4">
        <p className="font-display text-3xl font-black uppercase leading-none">Pedido enviado!</p>
        <p>
          Salve este link para voltar ao seu pedido. <strong>Não mostre na live nem mande print dele.</strong>
        </p>
        <code className="break-all bg-surface p-3 font-mono text-sm">{link}</code>
        <div>
          <Botao type="button" variante="secundario" onClick={copiar}>
            {copiado ? "Link copiado" : "Copiar link"}
          </Botao>
        </div>
        <p className="text-sm text-fg-muted">É por ele que você manda o comprovante e acompanha a fila.</p>
      </div>
    );
  }

  const erroDe = (c: keyof Erros) => erros[c];

  return (
    <form ref={formRef} onSubmit={aoEnviar} className="flex flex-col gap-6" noValidate aria-describedby="erro-geral">
      <p className="text-fg-muted">Preenche aí e manda o comprovante.</p>

      <Campo id="nome" name="nome" rotulo="Nome completo" autoComplete="name" maxLength={120} required erro={erroDe("nome")} />

      <fieldset className="flex flex-col gap-2">
        <legend className="text-xs font-medium uppercase tracking-[0.18em] text-fg-muted">Tipo da chave Pix</legend>
        <div className="mt-1.5 grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
          {TIPOS_PIX.map((t) => (
            <label
              key={t}
              className="cursor-pointer bg-bg px-2 py-2.5 text-center text-sm transition-colors has-[:checked]:bg-accent has-[:checked]:font-semibold has-[:checked]:text-accent-fg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
            >
              <input
                type="radio"
                name="pixTipo"
                value={t}
                checked={tipoPix === t}
                onChange={() => trocarTipo(t)}
                className="sr-only"
              />
              {ROTULO_TIPO_PIX[t]}
            </label>
          ))}
        </div>
      </fieldset>

      <Campo
        id="pixChave"
        name="pixChave"
        rotulo={`Chave Pix (${ROTULO_TIPO_PIX[tipoPix]})`}
        value={pixChave}
        onChange={(e) => aoMudarPix(e.target.value)}
        placeholder={PLACEHOLDER_PIX[tipoPix]}
        inputMode={tipoPix === "cpf" || tipoPix === "telefone" ? "numeric" : tipoPix === "email" ? "email" : "text"}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        required
        erro={erroDe("pixChave")}
      />

      <Campo
        id="plataformaId"
        name="plataformaId"
        rotulo={`ID na ${plataforma}`}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={40}
        required
        erro={erroDe("plataformaId")}
      />

      <Campo
        id="cpf"
        name="cpf"
        rotulo={`CPF cadastrado na ${plataforma}`}
        value={cpf}
        onChange={(e) => setCpf(mascaraCpf(e.target.value))}
        placeholder="000.000.000-00"
        inputMode="numeric"
        autoComplete="off"
        required
        erro={erroDe("cpf")}
      />

      <div className="flex flex-col gap-3 text-sm">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="privacidade"
            aria-invalid={erros.privacidade ? true : undefined}
            aria-describedby={erros.privacidade ? "erro-privacidade" : undefined}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>
            Li a{" "}
            <Link href="/privacidade" target="_blank" rel="noopener" className="underline underline-offset-4">
              política de privacidade
              <span className="sr-only"> (abre em nova aba)</span>
            </Link>{" "}
            e sei para que meus dados são usados.
          </span>
        </label>
        {erros.privacidade ? (
          <p id="erro-privacidade" className="text-accent">
            {erros.privacidade}
          </p>
        ) : null}
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="maioridade"
            aria-invalid={erros.maioridade ? true : undefined}
            aria-describedby={erros.maioridade ? "erro-maioridade" : undefined}
            className="mt-0.5 size-4 accent-accent"
          />
          <span>Tenho 18 anos ou mais.</span>
        </label>
        {erros.maioridade ? (
          <p id="erro-maioridade" className="text-accent">
            {erros.maioridade}
          </p>
        ) : null}
      </div>

      <Turnstile key={chaveTurnstile} siteKey={siteKey} acao="pedido" aoMudar={setTurnstile} />

      <p id="erro-geral" role="alert" aria-live="assertive" className="min-h-5 text-sm text-accent">
        {erroGeral}
      </p>

      <Botao carregando={enviando}>Enviar pedido</Botao>
    </form>
  );
}
