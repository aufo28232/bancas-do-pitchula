"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { enviar } from "@/lib/client/api";
import { esquecerPedido, temPedidoMarcado } from "@/lib/client/pedido-salvo";

/**
 * Quem já fez pedido e volta ao site cai direto no próprio pedido (D-082).
 * Na página de uma banca, só se o pedido for DESSA banca (`codigo`).
 * O servidor confere a sessão pelo cookie; pedido apagado (banca encerrada) = esquece.
 */
export function RetomarPedido({ codigo }: { codigo?: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!temPedidoMarcado()) return;
    let ativo = true;
    void enviar<{ banca: { codigo: string | null } }>("/api/pedido/estado").then((r) => {
      if (!ativo) return;
      if (r.ok) {
        if (!codigo || r.dados.banca.codigo === codigo) router.replace("/pedido");
      } else if (r.status === 401) {
        esquecerPedido();
      }
    });
    return () => {
      ativo = false;
    };
  }, [codigo, router]);
  return null;
}
