# Bancas do Pitchula

Aplicação para o streamer Pitchula e seus moderadores receberem pedidos de banca e registrarem os pagamentos feitos via Pix.

## Status

**Arquitetura aprovada em 27/10/2026.** Ainda não há código.

- [`ARCHITECTURE.md`](ARCHITECTURE.md): componentes, modelo de dados, permissões, fluxos, ameaças e plano de etapas
- [`DECISIONS.md`](DECISIONS.md): decisões (D-001 a D-047), alternativas e pendências jurídicas
- `public/pitchula.jpg`: foto oficial usada na página da banca

Próximo passo: **Etapa 1** (estrutura, Supabase local, migrations, RLS). Ela precisa de um ambiente com acesso ao registro do npm e com Docker, para rodar o Supabase local e os testes pgTAP. Ao fim de cada etapa, este README ganha os comandos exatos de configuração, testes e deploy.
