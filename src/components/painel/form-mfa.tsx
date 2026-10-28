"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { enviar } from "@/lib/client/api";

function CampoCodigo({ erro }: { erro: string }) {
  return (
    <Campo
      id="codigo"
      name="codigo"
      rotulo="Código de 6 dígitos"
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={6}
      required
      erro={erro || undefined}
      className="font-mono text-2xl tracking-[0.4em]"
    />
  );
}

/** Verificação do TOTP (já cadastrado). */
export function FormMfaVerificar({ fatorId }: { fatorId: string }) {
  const router = useRouter();
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const codigo = String(new FormData(e.currentTarget).get("codigo") ?? "").replace(/\D/g, "");
    setEnviando(true);
    setErro("");
    const r = await enviar<{ proximo: string }>("/api/painel/auth/mfa/verificar", { fatorId, codigo });
    if (r.ok) {
      router.replace(r.dados.proximo);
      router.refresh();
      return;
    }
    setErro(r.erro);
    setEnviando(false);
  }

  return (
    <form onSubmit={aoEnviar} className="flex flex-col gap-6" noValidate>
      <CampoCodigo erro={erro} />
      <Botao carregando={enviando}>Confirmar</Botao>
    </form>
  );
}

/** Cadastro do TOTP (primeiro acesso ou depois de um reset feito pelo streamer). */
export function FormMfaCadastrar() {
  const router = useRouter();
  const [dados, setDados] = useState<{ fatorId: string; qrCode: string; segredo: string } | null>(null);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function gerar() {
    setEnviando(true);
    setErro("");
    const r = await enviar<{ fatorId: string; qrCode: string; segredo: string }>("/api/painel/auth/mfa/inscrever", {});
    if (r.ok) setDados(r.dados);
    else setErro(r.erro);
    setEnviando(false);
  }

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!dados) return;
    const codigo = String(new FormData(e.currentTarget).get("codigo") ?? "").replace(/\D/g, "");
    setEnviando(true);
    setErro("");
    const r = await enviar<{ proximo: string }>("/api/painel/auth/mfa/verificar", { fatorId: dados.fatorId, codigo });
    if (r.ok) {
      router.replace(r.dados.proximo);
      router.refresh();
      return;
    }
    setErro(r.erro);
    setEnviando(false);
  }

  if (!dados) {
    return (
      <div className="flex flex-col gap-6">
        <p className="text-fg-muted">
          O painel exige um app autenticador (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).
          Faça isso longe da câmera da live.
        </p>
        <p role="alert" className="min-h-5 text-sm text-accent">
          {erro}
        </p>
        <Botao type="button" onClick={gerar} carregando={enviando}>
          Gerar QR code
        </Botao>
      </div>
    );
  }

  return (
    <form onSubmit={aoEnviar} className="flex flex-col gap-6" noValidate>
      <ol className="list-decimal space-y-2 pl-5 text-sm text-fg-muted">
        <li>Abra o app autenticador e escaneie o QR code.</li>
        <li>Digite o código de 6 dígitos que aparecer.</li>
      </ol>
      {/* O QR vem do Supabase Auth como data URI (img-src data: na CSP). */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={dados.qrCode} alt="QR code para cadastrar o app autenticador" width={200} height={200} className="bg-white p-2" />
      <details className="text-sm text-fg-muted">
        <summary className="cursor-pointer">Não consegue escanear? Use a chave manual</summary>
        <code className="mt-2 block break-all font-mono text-fg">{dados.segredo}</code>
      </details>
      <CampoCodigo erro={erro} />
      <Botao carregando={enviando}>Ativar</Botao>
    </form>
  );
}
