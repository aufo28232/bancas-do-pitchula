import { rpc } from "../postgrest";

export type BancaPainel = {
  id: string;
  code: string | null;
  name: string;
  total_cents: number;
  slots: number;
  per_person_cents: number;
  remainder_cents: number;
  ip_limit: boolean;
  status: "aberta" | "fechada" | "esgotada" | "encerrada";
  paid_count: number;
  order_count: number;
  pendentes: number;
  version: number;
  created_at: string;
  platform_name: string | null;
  signup_url: string | null;
};

export function listarBancas(token: string): Promise<BancaPainel[]> {
  return rpc<BancaPainel[]>("staff_list_bancas", {}, { token });
}
