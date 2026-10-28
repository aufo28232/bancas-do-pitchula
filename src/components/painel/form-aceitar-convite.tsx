"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { Turnstile } from "@/components/ui/turnstile";
import { enviar } from "@/lib/client/api";

/**
 * Aceite de convite. O token vem no FRAGMENTO da URL (#...), que não é enviado
 * ao servidor nem aparece em logs/Referer. Lemos e apagamos da barra na hora.
 */
export function FormAceitarConvite({ siteKey }: { siteKey: string }) {
  const router = useRouter();
  const [tokenConvite, setTokenConvite] = useState<string | null>(null);
  const [lido, setLido] = useState(false);
  const [turnstile, setTurnstile] = useState("");
  const [chave, setChave] = useState(0);
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    const t = window.location.hash.slice(1);
    history.replaceState(null, "", window.location.pathname);
    // Atualiza o estado fora do corpo síncrono do efeito (leitura única do fragmento).
    void Promise.resolve().then(() => {
      setTokenConvite(/^[A-Za-z0-9_-]{43}$/.test(t) ? t : null);
      setLido(true);
    });
  }, []);

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!tokenConvite) return;
    const f = new FormData(e.currentTarget);
    const senha = String(f.get("senha") ?? "");
    if (senha !== String(f.get("confirmacao") ?? "")) {
      setErro("As senhas não conferem.");
      return;
    }
    if (!turnstile) {
      setErro("Aguarde a verificação de segurança terminar.");
      return;
    }
    setEnviando(true);
    setErro("");
    const r = await enviar("/api/painel/convites/aceitar", {
      token: tokenConvite,
      email: String(f.get("email") ?? ""),
      senha,
      apelido: String(f.get("apelido") ?? ""),
      turnstile,
    });
    if (r.ok) {
      setPronto(true);
      return;
    }
    setErro(r.erro);
    setTurnstile("");
    setChave((k) => k + 1);
    setEnviando(false);
  }

  if (!lido) return null;
  if (pronto) {
    return (
      <div className="flex flex-col gap-6">
        <p>Conta criada. Agora entre com seu e-mail e senha e cadastre o app autenticador.</p>
        <Botao type="button" onClick={() => router.replace("/painel/entrar")}>
          Ir para o login
        </Botao>
      </div>
    );
  }
  if (!tokenConvite) {
    return <p className="text-fg-muted">Este link de convite está incompleto. Peça um novo link ao streamer.</p>;
  }

  return (
    <form onSubmit={aoEnviar} className="flex flex-col gap-6" noValidate>
      <Campo id="apelido" name="apelido" rotulo="Apelido (aparece para os espectadores)" maxLength={32} required autoComplete="nickname" />
      <Campo id="email" name="email" type="email" rotulo="E-mail" autoComplete="username" required />
      <Campo
        id="senha"
        name="senha"
        type="password"
        rotulo="Senha"
        autoComplete="new-password"
        minLength={12}
        required
        dica="Mínimo de 12 caracteres. Senhas que já vazaram na internet são recusadas."
      />
      <Campo id="confirmacao" name="confirmacao" type="password" rotulo="Repita a senha" autoComplete="new-password" required />
      <Turnstile key={chave} siteKey={siteKey} acao="convite" aoMudar={setTurnstile} />
      <p role="alert" aria-live="assertive" className="min-h-5 text-sm text-accent">
        {erro}
      </p>
      <Botao carregando={enviando}>Criar conta</Botao>
    </form>
  );
}
