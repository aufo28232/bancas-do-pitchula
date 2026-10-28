"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Botao } from "@/components/ui/botao";
import { Campo } from "@/components/ui/campo";
import { enviar } from "@/lib/client/api";

export function FormResposta() {
  const router = useRouter();
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setEnviando(true);
    setErro("");
    const r = await enviar("/api/painel/respostas/salvar", {
      rotulo: String(f.get("rotulo") ?? ""),
      texto: String(f.get("texto") ?? ""),
    });
    setEnviando(false);
    if (!r.ok) {
      setErro(r.erro);
      return;
    }
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={aoEnviar} className="flex flex-col gap-4 border border-line p-4" noValidate>
      <Campo id="rotulo-resposta" name="rotulo" rotulo="Nome do botão" maxLength={40} required />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="texto-resposta" className="text-xs font-medium uppercase tracking-[0.18em] text-fg-muted">
          Texto da mensagem
        </label>
        <textarea
          id="texto-resposta"
          name="texto"
          rows={3}
          maxLength={500}
          required
          className="resize-none border-0 border-b border-line bg-transparent py-2 outline-none focus:border-accent"
        />
      </div>
      <p role="alert" className="min-h-5 text-sm text-accent">
        {erro}
      </p>
      <Botao carregando={enviando} className="sm:w-auto">
        Adicionar resposta
      </Botao>
    </form>
  );
}
