import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { createEnginneServer } from "./mcpServer.js";
import { getDb } from "../database/db.js";
import {
  ensureSellerPlaceholder,
  consumePendingAuthorization,
  saveTokens,
  markSellerError,
  recordAudit,
  getSellerByName,
} from "../database/sellersRepo.js";
import { startAuthorization, exchangeCodeForTokens, OAuthError } from "../auth/oauth.js";

const log = childLogger("http-server");

// Garante schema criado e falha rápido se DATABASE_PATH não for gravável.
getDb();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

// ---------------------------------------------------------------------------
// Autenticação do endpoint MCP: exige Authorization: Bearer <MCP_API_KEY>.
// Sem isso, qualquer pessoa que descobrisse a URL pública leria dados de
// TODOS os sellers conectados. As rotas de OAuth (/oauth/*) ficam de fora
// porque precisam ser acessíveis pelo navegador do próprio seller.
// ---------------------------------------------------------------------------
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token !== env.MCP_API_KEY) {
    res.status(401).json({ error: "unauthorized", message: "Authorization: Bearer <MCP_API_KEY> ausente ou inválido" });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// /health — checagem simples e pública para o provedor de hosting (uptime).
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "ml-enginne", time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// /oauth/start — inicia o fluxo de autorização de UM seller. Um humano deve
// abrir esta URL no navegador (é uma tela de login/consentimento do Mercado
// Livre — não pode ser automatizada). Ver README > "Adicionar um seller".
// ---------------------------------------------------------------------------
app.get("/oauth/start", (req, res) => {
  const sellerName = String(req.query.seller ?? "").trim();
  if (!sellerName || !/^[a-z0-9_-]+$/i.test(sellerName)) {
    res.status(400).send("Parâmetro ?seller=nome_interno é obrigatório (letras, números, - e _ apenas).");
    return;
  }
  ensureSellerPlaceholder(sellerName);
  const url = startAuthorization(sellerName);
  recordAudit(sellerName, "oauth_start");
  res.redirect(url);
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

  const pending = consumePendingAuthorization(state);
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
    saveTokens(pending.seller_name, tokens);
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
    markSellerError(pending.seller_name, message);
    recordAudit(pending.seller_name, "oauth_error", message);
    log.error({ seller: pending.seller_name, err: message }, "falha ao trocar code por token");
    res.status(500).send(renderHtml("Falha na autorização", message));
  }
});

function renderHtml(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#1a1a1a}
  h1{font-size:20px}</style></head>
  <body><h1>${title}</h1><p>${message}</p></body></html>`;
}

// ---------------------------------------------------------------------------
// /mcp — endpoint MCP (Streamable HTTP). Protegido por Bearer token.
// Uma sessão McpServer+Transport por `mcp-session-id`, como recomendado
// pelo SDK oficial para servidores multi-cliente.
// ---------------------------------------------------------------------------
const sessions = new Map<string, { transport: StreamableHTTPServerTransport }>();

app.post("/mcp", requireApiKey, async (req, res) => {
  const sessionIdHeader = req.header("mcp-session-id");

  try {
    if (sessionIdHeader && sessions.has(sessionIdHeader)) {
      const { transport } = sessions.get(sessionIdHeader)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionIdHeader && isInitializeRequest(req.body)) {
      const server = createEnginneServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { transport });
          log.info({ sessionId }, "sessão MCP iniciada");
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          log.info({ sessionId: transport.sessionId }, "sessão MCP encerrada");
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Sessão inválida: envie mcp-session-id ou uma requisição de initialize." },
      id: null,
    });
  } catch (err) {
    log.error({ err: String(err) }, "erro ao processar requisição MCP");
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Erro interno" }, id: null });
    }
  }
});

async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionIdHeader = req.header("mcp-session-id");
  if (!sessionIdHeader || !sessions.has(sessionIdHeader)) {
    res.status(404).send("Sessão MCP não encontrada");
    return;
  }
  const { transport } = sessions.get(sessionIdHeader)!;
  await transport.handleRequest(req, res);
}

app.get("/mcp", requireApiKey, handleSessionRequest);
app.delete("/mcp", requireApiKey, handleSessionRequest);

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, publicBaseUrl: env.PUBLIC_BASE_URL }, "Enginne MCP server no ar");
});
