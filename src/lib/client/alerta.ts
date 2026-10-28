/**
 * Aviso de "seu pedido foi assumido" (D-046): beep, vibração e título piscando.
 * O navegador só libera áudio depois de um gesto da pessoa, por isso o som
 * precisa ser ATIVADO num clique ("Ativar som"); sem isso, só o aviso visual.
 */
type JanelaComAudio = Window & { webkitAudioContext?: typeof AudioContext };

let contexto: AudioContext | null = null;

/**
 * Chamado no clique de "Ativar som" (toca um bipe curto de confirmação) ou, em
 * silêncio, no primeiro toque em qualquer lugar da página.
 */
export async function ativarSom(silencioso = false): Promise<boolean> {
  const Ctor = window.AudioContext ?? (window as JanelaComAudio).webkitAudioContext;
  if (!Ctor) return false;
  contexto ??= new Ctor();
  try {
    if (contexto.state === "suspended") await contexto.resume();
  } catch {
    return false;
  }
  if (!silencioso) bipe(1);
  return contexto.state === "running";
}

export function somAtivo(): boolean {
  return contexto?.state === "running";
}

/** `vezes` bipes de 880 Hz, 160 ms cada, com envelope suave (sem estalo). */
export function bipe(vezes = 2): void {
  const ctx = contexto;
  if (!ctx || ctx.state !== "running") return;
  const inicio = ctx.currentTime + 0.02;
  for (let i = 0; i < vezes; i++) {
    const t = inicio + i * 0.28;
    const osc = ctx.createOscillator();
    const ganho = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, t);
    ganho.gain.setValueAtTime(0.0001, t);
    ganho.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    ganho.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(ganho).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.18);
  }
}

let piscando: ReturnType<typeof setInterval> | null = null;

/** Alterna o título da aba até a pessoa voltar para ela. */
export function piscarTitulo(texto: string): void {
  if (piscando || document.visibilityState === "visible") return;
  const original = document.title;
  let alterna = false;
  piscando = setInterval(() => {
    alterna = !alterna;
    document.title = alterna ? texto : original;
  }, 1000);
  const parar = () => {
    if (document.visibilityState !== "visible") return;
    if (piscando) clearInterval(piscando);
    piscando = null;
    document.title = original;
    document.removeEventListener("visibilitychange", parar);
  };
  document.addEventListener("visibilitychange", parar);
}

export function alertarAssumido(): void {
  bipe(2);
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    // Sem vibração neste aparelho.
  }
  piscarTitulo("🔔 Seu pedido foi assumido");
}
