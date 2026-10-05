import express, { type NextFunction, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { createEnginneServer } from "./mcpServer.js";
import { getStore } from "../database/db.js";
import {
  ensureSellerPlaceholder,
  consumePendingAuthorization,
  saveTokens,
  markSellerError,
  recordAudit,
} from "../database/sellersRepo.js";
import { startAuthorization, exchangeCodeForTokens, OAuthError } from "../auth/oauth.js";
import { startBlingAuthorization, exchangeBlingCodeForTokens, BlingOAuthError } from "../auth/oauthBling.js";
import {
  ensureBlingSellerPlaceholder,
  consumeBlingPendingAuthorization,
  saveBlingTokens,
  markBlingSellerError,
} from "../database/blingSellersRepo.js";

const log = childLogger("http-server");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// Autenticação do endpoint MCP. Sem isso, qualquer pessoa que descobrisse a
// URL pública leria dados de TODOS os sellers conectados. Aceita a chave
// MCP_API_KEY de duas formas (escolha uma ao cadastrar o conector no Claude):
//   1) no endereço:   https://<servidor>/mcp/<MCP_API_KEY>
//   2) no cabeçalho:  Authorization: Bearer <MCP_API_KEY>
// As rotas de OAuth (/oauth/*) ficam de fora porque precisam ser acessíveis
// pelo navegador do próprio seller.
// ---------------------------------------------------------------------------
function chaveConfere(recebida: string | undefined): boolean {
  const a = Buffer.from(recebida ?? "");
  const b = Buffer.from(env.MCP_API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  const pelaUrl = chaveConfere(req.params.key);
  const peloCabecalho = scheme === "Bearer" && chaveConfere(token);
  if (!pelaUrl && !peloCabecalho) {
    res.status(401).json({ error: "unauthorized", message: "Chave do conector ausente ou inválida" });
    return;
  }
  next();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ---------------------------------------------------------------------------
// /health — checagem simples e pública para o provedor de hosting (uptime).
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ml-enginne", time: new Date().toISOString() });
});

app.get("/", (_req, res) => {
  res.send("Conector MCP Enginne (Mercado Livre) no ar.");
});

// ---------------------------------------------------------------------------
// /oauth/start — inicia o fluxo de autorização de UM seller. Um humano deve
// abrir esta URL no navegador (é uma tela de login/consentimento do Mercado
// Livre — não pode ser automatizada). Ver README > "Adicionar um seller".
// ---------------------------------------------------------------------------
app.get("/oauth/start", async (req, res) => {
  const sellerName = String(req.query.seller ?? "").trim();
  if (!sellerName || !/^[a-z0-9_-]+$/i.test(sellerName)) {
    res.status(400).send("Parâmetro ?seller=nome_interno é obrigatório (letras, números, - e _ apenas).");
    return;
  }
  try {
    await ensureSellerPlaceholder(sellerName);
    const url = await startAuthorization(sellerName);
    recordAudit(sellerName, "oauth_start");
    res.redirect(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ seller: sellerName, err: message }, "falha ao iniciar autorização");
    res.status(500).send(renderHtml("Falha ao iniciar a autorização", message));
  }
});

// ---------------------------------------------------------------------------
// /oauth/callback — o Mercado Livre redireciona o navegador do seller para
// cá com ?code=...&state=.... Trocamos o code por tokens e persistimos
// cifrados. Esta URL é a mesma configurada como Redirect URI no app ML.
// ---------------------------------------------------------------------------
app.get("/oauth/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  if (error) {
    res.status(400).send(renderHtml("Autorização cancelada", `O Mercado Livre retornou: ${error} — ${error_description ?? ""}`));
    return;
  }
  if (!code || !state) {
    res.status(400).send(renderHtml("Requisição inválida", "Parâmetros code/state ausentes."));
    return;
  }

  const pending = await consumePendingAuthorization(state);
  if (!pending) {
    res.status(400).send(renderHtml("Sessão expirada", "O link de autorização expirou ou já foi usado. Gere um novo com /oauth/start?seller=NOME."));
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens({
      code,
      redirectUri: pending.redirect_uri,
      codeVerifier: pending.code_verifier,
    });
    await saveTokens(pending.seller_name, tokens);
    recordAudit(pending.seller_name, "oauth_authorized");
    log.info({ seller: pending.seller_name }, "seller autorizado com sucesso");
    res.send(
      renderHtml(
        "Conta conectada!",
        `A conta "${pending.seller_name}" foi autorizada com sucesso e já pode ser consultada pelo Claude. Você pode fechar esta janela.`
      )
    );
  } catch (err) {
    const message = err instanceof OAuthError ? err.message : err instanceof Error ? err.message : String(err);
    await markSellerError(pending.seller_name, message);
    recordAudit(pending.seller_name, "oauth_error", message);
    log.error({ seller: pending.seller_name, err: message }, "falha ao trocar code por token");
    res.status(500).send(renderHtml("Falha na autorização", message));
  }
});

// ---------------------------------------------------------------------------
// /oauth/bling/start — inicia o fluxo de autorização de UMA conta Bling.
// Mesmo padrão do /oauth/start (Mercado Livre): um humano abre esta URL no
// navegador para fazer login/consentimento no Bling.
// ---------------------------------------------------------------------------
app.get("/oauth/bling/start", async (req, res) => {
  const sellerName = String(req.query.seller ?? "").trim();
  if (!sellerName || !/^[a-z0-9_-]+$/i.test(sellerName)) {
    res.status(400).send("Parâmetro ?seller=nome_interno é obrigatório (letras, números, - e _ apenas).");
    return;
  }
  try {
    await ensureBlingSellerPlaceholder(sellerName);
    const url = await startBlingAuthorization(sellerName);
    res.redirect(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).send(renderHtml("Bling não configurado", message));
  }
});

// ---------------------------------------------------------------------------
// /oauth/bling/callback — o Bling redireciona o navegador para cá com
// ?code=...&state=.... Esta é a MESMA URL que deve estar cadastrada como
// "Link de redirecionamento" no app criado em developer.bling.com.br.
// ---------------------------------------------------------------------------
app.get("/oauth/bling/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query as Record<string, string | undefined>;

  if (error) {
    res.status(400).send(renderHtml("Autorização cancelada", `O Bling retornou: ${error} — ${error_description ?? ""}`));
    return;
  }
  if (!code || !state) {
    res.status(400).send(renderHtml("Requisição inválida", "Parâmetros code/state ausentes."));
    return;
  }

  const pending = await consumeBlingPendingAuthorization(state);
  if (!pending) {
    res
      .status(400)
      .send(renderHtml("Sessão expirada", "O link de autorização expirou ou já foi usado. Gere um novo com /oauth/bling/start?seller=NOME."));
    return;
  }

  try {
    const tokens = await exchangeBlingCodeForTokens({ code });
    await saveBlingTokens(pending.seller_name, tokens);
    res.send(
      renderHtml(
        "Conta Bling conectada!",
        `A conta "${pending.seller_name}" foi autorizada com sucesso no Bling e já pode ser consultada pelo Claude. Você pode fechar esta janela.`
      )
    );
  } catch (err) {
    const message = err instanceof BlingOAuthError ? err.message : err instanceof Error ? err.message : String(err);
    await markBlingSellerError(pending.seller_name, message);
    res.status(500).send(renderHtml("Falha na autorização Bling", message));
  }
});

function renderHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
  <style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#1a1a1a}
  h1{font-size:20px}</style></head>
  <body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

// ---------------------------------------------------------------------------
// /mcp — endpoint MCP (Streamable HTTP), protegido pela MCP_API_KEY.
// Sem sessão em memória: cada requisição cria seu próprio McpServer+Transport.
// Assim o conector continua funcionando quando o Cloud Run desliga a instância
// por inatividade, reinicia ou coloca mais de uma no ar.
// ---------------------------------------------------------------------------
async function handleMcp(req: Request, res: Response): Promise<void> {
  try {
    const server = createEnginneServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error({ err: String(err) }, "erro ao processar requisição MCP");
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
    }
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST." }, id: null });
}

app.post("/mcp", requireApiKey, handleMcp);
app.post("/mcp/:key", requireApiKey, handleMcp);
app.get(["/mcp", "/mcp/:key"], requireApiKey, methodNotAllowed);
app.delete(["/mcp", "/mcp/:key"], requireApiKey, methodNotAllowed);

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, publicBaseUrl: env.PUBLIC_BASE_URL, store: getStore().kind }, "Enginne MCP server no ar");
});
