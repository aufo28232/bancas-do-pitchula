import { RealtimeClient, type RealtimeChannel } from "@supabase/realtime-js";

/**
 * Conexão com o Supabase Realtime SÓ PARA OUVIR (D-008).
 * - Canais sempre PRIVADOS: o Realtime consulta a RLS de realtime.messages antes de
 *   deixar entrar (pedido:{id} só para o dono, vagas:{código} só leitura).
 * - O site nunca envia broadcast: não existe política de INSERT.
 * - Se a conexão cair, quem usa isto mantém um polling de reserva.
 */
export type Ouvinte = Record<string, (payload: Record<string, unknown>) => void>;

const pareceJwt = (s: string) => s.split(".").length === 3;

export class TempoReal {
  private cliente: RealtimeClient;
  private canais: RealtimeChannel[] = [];

  constructor(url: string, chavePublica: string) {
    const ws = new URL("realtime/v1", url.endsWith("/") ? url : `${url}/`);
    ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
    this.cliente = new RealtimeClient(ws.toString(), { params: { apikey: chavePublica } });
    // Visitante sem login: entra como "anon" usando a chave pública (quando ela é um JWT).
    if (pareceJwt(chavePublica)) void this.cliente.setAuth(chavePublica);
  }

  /** Troca o token (o do espectador vale 5 min; a página renova antes de vencer). */
  async definirToken(token: string): Promise<void> {
    await this.cliente.setAuth(token);
  }

  ouvir(topico: string, eventos: Ouvinte, aoMudarEstado: (conectado: boolean) => void): void {
    const canal = this.cliente.channel(topico, { config: { private: true, broadcast: { self: false, ack: false } } });
    for (const [evento, fn] of Object.entries(eventos)) {
      canal.on("broadcast", { event: evento }, (msg: { payload?: unknown }) => {
        const p = msg.payload;
        fn(typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {});
      });
    }
    canal.subscribe((estado) => aoMudarEstado(String(estado) === "SUBSCRIBED"));
    this.canais.push(canal);
  }

  encerrar(): void {
    for (const c of this.canais) void this.cliente.removeChannel(c);
    this.canais = [];
    this.cliente.disconnect();
  }
}
