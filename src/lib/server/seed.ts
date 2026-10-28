import { adminApagarUsuario, adminCriarUsuario } from "./gotrue";
import { rpc } from "./postgrest";
import { problemaDeTamanho, senhaVazada, MENSAGEM_SENHA } from "./senha";

/**
 * Cria a conta do streamer (owner). Única forma de criar o owner: não há
 * cadastro público (enunciado §5). Falha se já existir um owner ativo.
 */
export async function criarStreamer(opcoes: {
  email: string;
  senha: string;
  apelido: string;
  hibpUrl?: string;
}): Promise<string> {
  const problema = problemaDeTamanho(opcoes.senha);
  if (problema) throw new Error(MENSAGEM_SENHA[problema]);
  if (await senhaVazada(opcoes.senha, opcoes.hibpUrl)) throw new Error(MENSAGEM_SENHA.vazada);

  const criado = await adminCriarUsuario(opcoes.email.trim().toLowerCase(), opcoes.senha);
  if (criado === "conflito") throw new Error("Já existe uma conta com esse e-mail.");
  if (!criado) throw new Error("Não foi possível criar a conta no Supabase Auth.");

  try {
    await rpc("srv_seed_owner", { p_user: criado.id, p_display_name: opcoes.apelido }, "servico");
  } catch (e) {
    await adminApagarUsuario(criado.id).catch(() => undefined);
    throw e;
  }
  return criado.id;
}
