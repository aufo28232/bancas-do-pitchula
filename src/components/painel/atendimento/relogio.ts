"use client";

import { useEffect, useState } from "react";

/** Relógio que bate a cada segundo (0 até o primeiro tique, para não depender da hora na renderização). */
export function useRelogio(): number {
  const [agora, setAgora] = useState(0);
  useEffect(() => {
    const tique = () => setAgora(Date.now());
    const primeiro = setTimeout(tique, 0);
    const id = setInterval(tique, 1000);
    return () => {
      clearTimeout(primeiro);
      clearInterval(id);
    };
  }, []);
  return agora;
}

export function formatarRestante(seg: number): string {
  const s = Math.max(0, Math.ceil(seg));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Chave de idempotência para uma ação (clique duplo e reenvio usam a mesma). */
export function novaChave(): string {
  return crypto.randomUUID();
}
