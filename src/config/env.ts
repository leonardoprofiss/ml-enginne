import "dotenv/config";
import { z } from "zod";

/**
 * Validação central de variáveis de ambiente.
 * Nada de credencial sensível tem valor default: se faltar, o processo
 * falha cedo (fail-fast) em vez de rodar com config incompleta/insegura.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Porta do servidor MCP remoto (HTTP/Streamable HTTP)
  PORT: z.coerce.number().int().positive().default(8787),

  // URL pública e estável deste servidor (usada para montar o redirect_uri
  // do OAuth: <PUBLIC_BASE_URL>/oauth/callback). Deve ser HTTPS em produção.
  PUBLIC_BASE_URL: z.string().url(),

  // Credenciais da aplicação Mercado Livre (uma aplicação, N sellers).
  ML_CLIENT_ID: z.string().min(1, "ML_CLIENT_ID é obrigatório"),
  ML_CLIENT_SECRET: z.string().min(1, "ML_CLIENT_SECRET é obrigatório"),

  // Domínio de autorização do país (padrão Brasil). Ver lista de domínios
  // por país na documentação oficial (auth.mercadolivre.com.<país>).
  ML_AUTH_DOMAIN: z.string().default("auth.mercadolivre.com.br"),
  ML_API_BASE_URL: z.string().url().default("https://api.mercadolibre.com"),

  // Chave mestra usada para cifrar (AES-256-GCM) access_token/refresh_token
  // em repouso no banco. Deve ter 32 bytes quando decodificada de base64.
  // Gerar com: openssl rand -base64 32
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1, "TOKEN_ENCRYPTION_KEY é obrigatório (32 bytes em base64 — gere com `openssl rand -base64 32`)"),

  // Chave usada para proteger o endpoint MCP remoto (Authorization: Bearer <key>).
  // Sem isso, qualquer pessoa que descubra a URL pública leria dados de todos os sellers.
  MCP_API_KEY: z.string().min(16, "MCP_API_KEY deve ter pelo menos 16 caracteres"),

  // Caminho do arquivo SQLite (trocar por Postgres em produção multi-instância — ver README).
  DATABASE_PATH: z.string().default("./data/enginne.sqlite"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    // eslint-disable-next-line no-console
    console.error(
      `\n[config] Variáveis de ambiente inválidas ou ausentes:\n${issues}\n\nConsulte .env.example.\n`
    );
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
