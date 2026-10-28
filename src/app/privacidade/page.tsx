import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/config/site";
import { getServerEnv } from "@/lib/env";

export const metadata: Metadata = {
  title: "Política de privacidade",
  description: `Quais dados as bancas do ${site.streamer} coletam, para quê e por quanto tempo.`,
};

/*
 * Texto em linguagem simples. As bases legais são uma PROPOSTA técnica
 * (DECISIONS D-035) e precisam ser validadas por um advogado antes da produção.
 */
export default function Privacidade() {
  const { PLATFORM_NAME } = getServerEnv();
  return (
    <main className="relative z-[1] mx-auto w-full max-w-2xl px-4 py-12 sm:py-16">
      <p className="font-display text-sm font-extrabold uppercase tracking-[0.35em] text-fg-muted">
        Banca do {site.streamer}
      </p>
      <h1 className="mt-3 font-display text-5xl font-black uppercase leading-none">Privacidade</h1>
      <p className="mt-6 text-fg-muted">
        Esta página explica quais dados pedimos quando você participa de uma banca, para que servem, quanto tempo
        ficam guardados e como pedir a exclusão.
      </p>

      <div className="mt-10 flex flex-col gap-10 leading-relaxed">
        <section aria-labelledby="t-dados">
          <h2 id="t-dados" className="font-display text-2xl font-black uppercase">Quais dados e para quê</h2>
          <dl className="mt-4 divide-y divide-line border-y border-line">
            {[
              ["Nome completo", "Conferir se bate com o titular da chave Pix na hora do pagamento."],
              ["Chave Pix", "Fazer o pagamento."],
              [`ID na ${PLATFORM_NAME}`, "Conferir o comprovante de depósito e impedir pedidos duplicados."],
              [`CPF cadastrado na ${PLATFORM_NAME}`, "Conferir o comprovante de depósito e impedir pedidos duplicados."],
              ["Comprovante de depósito (imagem)", "Conferir que você cumpriu a condição da banca."],
              ["Mensagens do chat do pedido", "Atender o seu pedido."],
              ["Endereço IP", "Segurança, prevenção a fraude e limite de pedidos."],
            ].map(([dado, finalidade]) => (
              <div key={dado} className="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
                <dt className="font-medium">{dado}</dt>
                <dd className="text-fg-muted">{finalidade}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-fg-muted">
            Não usamos seus dados para publicidade, não vendemos nem compartilhamos com terceiros e não usamos
            ferramentas de rastreamento ou análise de terceiros. Usamos só cookies necessários para o site funcionar.
          </p>
        </section>

        <section aria-labelledby="t-tempo">
          <h2 id="t-tempo" className="font-display text-2xl font-black uppercase">Por quanto tempo</h2>
          <ul className="mt-4 list-disc space-y-2 pl-5 text-fg-muted">
            <li>
              Seus dados, mensagens e comprovantes são <strong className="text-fg">apagados quando a banca é encerrada</strong>.
              Uma banca é encerrada pelo streamer ou automaticamente (24h depois de esgotar, ou depois de 7 dias parada).
            </li>
            <li>
              Se você for banido por fraude, guardamos só uma &quot;impressão digital&quot; irreversível do dado (não o dado em
              si) e o motivo, enquanto o banimento estiver ativo. Banimentos são revisados a cada 12 meses.
            </li>
            <li>Os totais de cada banca (quantos pedidos, quanto foi pago) são guardados sem nenhum dado pessoal.</li>
            <li>
              Cópias de segurança do banco de dados podem manter dados apagados por um período curto, até a cópia expirar.
            </li>
          </ul>
        </section>

        <section aria-labelledby="t-seguranca">
          <h2 id="t-seguranca" className="font-display text-2xl font-black uppercase">Como protegemos</h2>
          <p className="mt-4 text-fg-muted">
            Nome, CPF, chave Pix e ID ficam criptografados. Só o streamer e os moderadores autenticados com verificação em
            duas etapas conseguem ver. O link do seu pedido é pessoal: não
            mostre na live nem mande print dele.
          </p>
        </section>

        <section aria-labelledby="t-direitos">
          <h2 id="t-direitos" className="font-display text-2xl font-black uppercase">Seus direitos</h2>
          <p className="mt-4 text-fg-muted">
            Você pode pedir acesso, correção ou exclusão dos seus dados a qualquer momento pelo chat do seu pedido. A
            exclusão cancela o pedido, se ele ainda não foi pago. Nunca pedimos senha nem pagamento antecipado.
          </p>
        </section>
      </div>

      <p className="mt-12">
        <Link href="/" className="underline underline-offset-4">
          Voltar ao início
        </Link>
      </p>
      <SiteFooter />
    </main>
  );
}
