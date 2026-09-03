import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { generatePkcePair, generateState } from "../utils/crypto.js";
import { savePendingAuthorization, type TokenSet } from "../database/sellersRepo.js";

const log = childLogger("oauth");

/**
 * Implementa o fluxo "Authorization Code" (server side) descrito na
 * documentação oficial do Mercado Livre:
 * https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao
 *
 * Pontos importantes replicados aqui:
 * - redirect_uri deve ser IDÊNTICO ao cadastrado no app (HTTPS, sem partes
 *   variáveis) — por isso usamos sempre `${PUBLIC_BASE_URL}/oauth/callback`.
 * - PKCE é opcional mas recomendado; usamos sempre (S256).
 * - `state` é obrigatório na prática para amarrar a resposta ao seller certo
 *   (o ML não valida o state — a validação é responsabilidade nossa).
 * - scope solicitado: "offline_access read write" (V2 — inclui escrita, para
 *   criar_anuncio/editar_anuncio; V1 pedia só "offline_access read"). Um
 *   seller que autorizou na V1 tem token com escopo antigo (só "read") — as
 *   tools de escrita retornam 403 da ML para ele até reautorizar
 *   (`npm run oauth:add-seller -- <seller>` de novo gera um novo consentimento
 *   já com "write").
 */

export const OAUTH_SCOPE = "offline_access read write";

export function getRedirectUri(): string {
  return new URL("/oauth/callback", env.PUBLIC_BASE_URL).toString();
}

/**
 * Inicia o fluxo para um seller: gera state + PKCE, persiste como "pending"
 * e retorna a URL de autorização para a qual o navegador do cliente deve ir.
 */
export function startAuthorization(sellerName: string): string {
  const state = generateState();
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const redirectUri = getRedirectUri();

  savePendingAuthorization({ state, sellerName, codeVerifier, redirectUri });

  const url = new URL(`https://${env.ML_AUTH_DOMAIN}/authorization`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.ML_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  log.info({ sellerName }, "authorization url gerada");
  return url.toString();
}

interface MlTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  user_id: number;
  refresh_token: string;
}

interface MlTokenError {
  error: string;
  error_description?: string;
  status?: number;
  message?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${env.ML_API_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  const json = (await res.json()) as MlTokenResponse | MlTokenError;

  if (!res.ok || "error" in json) {
    const err = json as MlTokenError;
    log.error({ status: res.status, error: err.error, description: err.error_description }, "falha ao obter token");
    throw new OAuthError(err.error ?? "unknown_error", err.error_description ?? `HTTP ${res.status}`);
  }

  const ok = json as MlTokenResponse;
  return {
    accessToken: ok.access_token,
    refreshToken: ok.refresh_token,
    scope: ok.scope,
    expiresInSeconds: ok.expires_in,
    mlUserId: String(ok.user_id),
  };
}

export class OAuthError extends Error {
  constructor(public code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "OAuthError";
  }
}

/** Troca o authorization code (recebido no /oauth/callback) por tokens. */
export async function exchangeCodeForTokens(params: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenSet> {
  return postToken({
    grant_type: "authorization_code",
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
}

/**
 * Renova o access_token usando o refresh_token. IMPORTANTE (doc oficial):
 * o refresh_token é de uso único — cada renovação retorna um novo
 * refresh_token que DEVE substituir o anterior no banco.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return postToken({
    grant_type: "refresh_token",
    client_id: env.ML_CLIENT_ID,
    client_secret: env.ML_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
}
