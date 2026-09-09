import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { generateState } from "../utils/crypto.js";
import { saveBlingPendingAuthorization, type BlingTokenSet } from "../database/blingSellersRepo.js";

const log = childLogger("oauth-bling");

function assertBlingConfigured(): void {
  if (!env.BLING_CLIENT_ID || !env.BLING_CLIENT_SECRET) {
    throw new Error(
      "BLING_CLIENT_ID / BLING_CLIENT_SECRET não configurados nas variáveis de ambiente."
    );
  }
}

export function getBlingRedirectUri(): string {
  return new URL("/oauth/bling/callback", env.PUBLIC_BASE_URL).toString();
}

export function startBlingAuthorization(sellerName: string): string {
  assertBlingConfigured();
  const state = generateState();
  const redirectUri = getBlingRedirectUri();

  saveBlingPendingAuthorization({ state, sellerName, redirectUri });

  const url = new URL(`${env.BLING_AUTH_DOMAIN}/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.BLING_CLIENT_ID!);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);

  log.info({ sellerName }, "authorization url gerada (bling)");
  return url.toString();
}

interface BlingTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token: string;
}

interface BlingTokenError {
  error?: string;
  error_description?: string;
  message?: string;
}

export class BlingOAuthError extends Error {
  constructor(public code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "BlingOAuthError";
  }
}

function basicAuthHeader(): string {
  const raw = `${env.BLING_CLIENT_ID}:${env.BLING_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

async function postToken(body: Record<string, string>): Promise<BlingTokenSet> {
  assertBlingConfigured();
  const res = await fetch(`${env.BLING_API_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuthHeader(),
    },
    body: new URLSearchParams(body).toString(),
  });

  const json = (await res.json()) as BlingTokenResponse | BlingTokenError;

  if (!res.ok || "error" in json) {
    const err = json as BlingTokenError;
    log.error({ status: res.status, error: err.error, description: err.error_description }, "falha ao obter token bling");
    throw new BlingOAuthError(
      err.error ?? `http_${res.status}`,
      err.error_description ?? err.message ?? `HTTP ${res.status}`
    );
  }

  const ok = json as BlingTokenResponse;
  return {
    accessToken: ok.access_token,
    refreshToken: ok.refresh_token,
    scope: ok.scope,
    expiresInSeconds: ok.expires_in,
  };
}

export async function exchangeBlingCodeForTokens(params: { code: string }): Promise<BlingTokenSet> {
  return postToken({
    grant_type: "authorization_code",
    code: params.code,
  });
}

export async function refreshBlingTokens(refreshToken: string): Promise<BlingTokenSet> {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
