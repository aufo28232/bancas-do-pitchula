"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { enviar } from "@/lib/client/api";
import { esquecerPedido, temPedidoMarcado } from "@/lib/client/pedido-salvo";

/**
 * Quem já fez pedido e volta ao site cai direto no próprio pedido (D-082).
 * Na página de uma banca, só se o pedido for DESSA banca (`codigo`).
 * O servidor confere a sessão pelo cookie; pedido apagado (banca encerrada) = esquece.
 * `senao`: para onde ir quando não há pedido para retomar (tela inicial → banca atual, D-084).
 */
export function RetomarPedido({ codigo, senao }: { codigo?: string; senao?: string }) {
  const router = useRouter();
  useEffect(() => {
    if (!temPedidoMarcado()) {
      if (senao) router.replace(senao);
      return;
    }
    let ativo = true;
    void enviar<{ banca: { codigo: string | null } }>("/api/pedido/estado").then((r) => {
      if (!ativo) return;
      if (r.ok && (!codigo || r.dados.banca.codigo === codigo)) {
        router.replace("/pedido");
        return;
      }
      if (!r.ok && r.status === 401) esquecerPedido();
      if (senao) router.replace(senao);
    });
    return () => {
      ativo = false;
    };
  }, [codigo, senao, router]);
  return null;
}
