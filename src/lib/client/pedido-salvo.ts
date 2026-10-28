/**
 * "Tem pedido aberto neste navegador?" (D-082). A sessão de verdade é o cookie
 * httpOnly (o JavaScript não lê). Esta marca no localStorage só evita uma consulta
 * ao servidor em toda visita de quem nunca fez pedido. Não guarda nenhum dado.
 */
const CHAVE = "bp_pedido_aberto";

export function marcarPedidoAberto(): void {
  try {
    localStorage.setItem(CHAVE, "1");
  } catch {
    // Navegação privada ou armazenamento bloqueado: segue sem a marca.
  }
}

export function temPedidoMarcado(): boolean {
  try {
    return localStorage.getItem(CHAVE) === "1";
  } catch {
    return false;
  }
}

export function esquecerPedido(): void {
  try {
    localStorage.removeItem(CHAVE);
  } catch {
    // nada a fazer
  }
}
