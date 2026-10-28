"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { enviar } from "@/lib/client/api";

/**
 * Encerrar a banca (D-044, D-045): APAGA na hora todos os pedidos, conversas e
 * comprovantes, e o link deixa de existir. Pede o nome da banca para confirmar.
 */
export function EncerrarBanca({ id, nome }: { id: string; nome: string }) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [digitado, setDigitado] = useState("");
  const [erro, setErro] = useState("");
  const [enviando, setEnviando] = useState(false);
  // Mesma chave em reenvios (clique duplo, rede caiu): o banco devolve o mesmo resultado.
  const idem = useRef<string | null>(null);
  const confere = digitado.trim().toLowerCase() === nome.trim().toLowerCase();

  async function aoEnviar(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!confere) return;
    idem.current ??= crypto.randomUUID();
    setEnviando(true);
    setErro("");
    const r = await enviar("/api/painel/bancas/encerrar", { id, nome: digitado, idem: idem.current });
    setEnviando(false);
    if (!r.ok) {
      setErro(r.erro);
      return;
    }
    router.replace("/painel");
    router.refresh();
  }

  if (!aberto) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setAberto(true)}
          className="rounded-sm border border-line px-3 py-1.5 text-sm text-fg-muted hover:border-accent hover:text-accent"
        >
          Encerrar banca
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void aoEnviar(e)} className="flex flex-col gap-3 border border-accent p-4" aria-label="Encerrar banca">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-muted">
          Digite o nome da banca para confirmar: <strong className="text-fg">{nome}</strong>
        </span>
        <input
          value={digitado}
          onChange={(e) => setDigitado(e.target.value)}
          autoComplete="off"
          className="border-b border-line bg-transparent py-2 outline-none focus:border-accent"
        />
      </label>
      {erro ? (
        <p role="alert" className="text-sm text-accent">
          {erro}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!confere || enviando}
          className="rounded-sm border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-60"
        >
          {enviando ? "Encerrando…" : "Encerrar e apagar tudo"}
        </button>
        <button type="button" onClick={() => setAberto(false)} className="rounded-sm border border-line px-3 py-1.5 text-sm">
          Cancelar
        </button>
      </div>
    </form>
  );
}
