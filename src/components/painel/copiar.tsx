"use client";

import { useState } from "react";
import { Botao } from "@/components/ui/botao";

export function CopiarTexto({ texto, rotulo }: { texto: string; rotulo: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <Botao
      type="button"
      variante="secundario"
      onClick={() => navigator.clipboard.writeText(texto).then(() => setCopiado(true), () => setCopiado(false))}
    >
      {copiado ? "Copiado" : rotulo}
    </Botao>
  );
}
