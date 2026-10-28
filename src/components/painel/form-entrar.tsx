"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { Turnstile } from "@/components/ui/turnstile";
import { enviar } from "@/lib/client/api";

export function FormEntrar({ siteKey }: { siteKey: string }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [chave, setChave] = useState(0);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (!token) {
      setErro("Aguarde a verificação de segurança terminar.");
      return;
    }
    setEnviando(true);
    setErro("");
    const r = await enviar<{ proximo: string }>("/api/painel/auth/entrar", {
      email: String(form.get("email") ?? ""),
      senha: String(form.get("senha") ?? ""),
      turnstile: token,
    });
    if (r.ok) {
      router.replace(r.dados.proximo);
      return;
    }
    setErro(r.erro);
    setToken("");
    setChave((k) => k + 1); // token do Turnstile é de uso único
    setEnviando(false);
  }

  return (
    <form onSubmit={aoEnviar} className="flex flex-col gap-6" noValidate>
      <Campo id="email" name="email" type="email" rotulo="E-mail" autoComplete="username" required />
      <Campo id="senha" name="senha" type="password" rotulo="Senha" autoComplete="current-password" required />
      <Turnstile key={chave} siteKey={siteKey} acao="login" aoMudar={setToken} />
      <p role="alert" aria-live="assertive" className="min-h-5 text-sm text-accent">
        {erro}
      </p>
      <Botao carregando={enviando}>Entrar</Botao>
    </form>
  );
}
