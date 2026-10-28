/**
 * Cabeçalhos de segurança e proteções de API em cima do BUILD de produção
 * (o mesmo `node .next/standalone/server.js` que vai para o servidor).
 */
import { expect, test } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "cabeçalhos não dependem do aparelho");

const PAGINAS = ["/", "/privacidade", "/painel/entrar", "/pedido"];

test("toda página sai com CSP de nonce e os cabeçalhos de base", async ({ request }) => {
  for (const caminho of PAGINAS) {
    const r = await request.get(caminho, { maxRedirects: 0 });
    const h = r.headers();
    const csp = h["content-security-policy"] ?? "";
    expect(csp, caminho).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{20,}' 'strict-dynamic'/);
    expect(csp, caminho).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp, caminho).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(csp, caminho).toContain("frame-ancestors 'none'");
    expect(csp, caminho).toContain("object-src 'none'");
    expect(csp, caminho).toContain("base-uri 'none'");
    expect(h["x-frame-options"], caminho).toBe("DENY");
    expect(h["x-content-type-options"], caminho).toBe("nosniff");
    expect(h["strict-transport-security"], caminho).toContain("max-age=");
    expect(h["cross-origin-opener-policy"], caminho).toBe("same-origin");
    expect(h["permissions-policy"], caminho).toContain("camera=()");
    expect(h["x-powered-by"], caminho).toBeUndefined();
  }
});

test("nonce muda a cada requisição", async ({ request }) => {
  const nonce = async () => /'nonce-([^']+)'/.exec((await request.get("/")).headers()["content-security-policy"] ?? "")?.[1];
  expect(await nonce()).not.toBe(await nonce());
});

test("páginas com token ou dados pessoais: sem Referer e sem indexação", async ({ request }) => {
  for (const caminho of ["/pedido", "/painel/convite"]) {
    const r = await request.get(caminho);
    expect(r.headers()["referrer-policy"], caminho).toBe("no-referrer");
  }
  const painel = await request.get("/painel/entrar");
  expect(painel.headers()["x-robots-tag"]).toContain("noindex");
  expect(painel.headers()["cache-control"]).toContain("no-store");
});

test("cookie de CSRF com __Host-, Secure e SameSite=Strict", async ({ request }) => {
  // Página sem redirecionamento: "/" pode levar à banca atual (D-084) e o cookie já viria do 1º salto.
  const r = await request.get("/privacidade");
  const cookie = r.headersArray().find((x) => x.name.toLowerCase() === "set-cookie" && x.value.startsWith("__Host-bp_csrf="));
  expect(cookie?.value).toMatch(/; Secure/);
  expect(cookie?.value).toMatch(/SameSite=Strict/);
  expect(cookie?.value).toMatch(/Path=\//);
  expect(cookie?.value).not.toMatch(/Domain=/i);
});

test("API: sem token CSRF, de outra origem ou cross-site: 403; respostas sem cache", async ({ request }) => {
  const semToken = await request.post("/api/pedido/estado", { data: {} });
  expect(semToken.status()).toBe(403);
  expect(semToken.headers()["cache-control"]).toContain("no-store");

  const outraOrigem = await request.post("/api/painel/auth/entrar", {
    data: { email: "a@b.com", senha: "x", turnstile: "x" },
    headers: { origin: "https://site-malicioso.example", "x-csrf-token": "qualquer" },
  });
  expect(outraOrigem.status()).toBe(403);
  expect(await outraOrigem.json()).toEqual({ erro: expect.any(String), requestId: expect.any(String) });
});

test("rota interna de limpeza exige o segredo", async ({ request }) => {
  // 401 com LIMPEZA_SECRET configurado (CI); 404 quando a rota está desligada.
  expect([401, 404]).toContain((await request.post("/api/interno/limpeza")).status());
  const chute = await request.post("/api/interno/limpeza", { headers: { authorization: "Bearer chute-qualquer-de-32-caracteres-xx" } });
  expect([401, 404]).toContain(chute.status());
});

test("arquivos internos não são servidos", async ({ request }) => {
  for (const caminho of ["/.env", "/.env.local", "/package.json", "/supabase/config.toml", "/.next/server/app/page.js"]) {
    expect((await request.get(caminho)).status(), caminho).toBe(404);
  }
});
