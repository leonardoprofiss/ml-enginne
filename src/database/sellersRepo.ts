import { getStore } from "./db.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";
import { childLogger } from "../utils/logger.js";

const auditLog = childLogger("audit");

const SELLERS = "sellers";
const OAUTH_PENDING = "oauth_pending";

export type SellerStatus = "pending" | "active" | "expired" | "revoked" | "error";

export interface SellerRow {
  seller_name: string;
  ml_user_id: string | null;
  ml_nickname: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  scope: string | null;
  token_expires_at: string | null;
  authorized_at: string | null;
  status: SellerStatus;
  last_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** View pública/segura de um seller — NUNCA inclui tokens. Uso em tools e logs. */
export interface SellerPublic {
  sellerName: string;
  mlUserId: string | null;
  mlNickname: string | null;
  scope: string | null;
  status: SellerStatus;
  tokenExpiresAt: string | null;
  authorizedAt: string | null;
  lastRefreshedAt: string | null;
  lastError: string | null;
}

export function toPublic(row: SellerRow): SellerPublic {
  return {
    sellerName: row.seller_name,
    mlUserId: row.ml_user_id,
    mlNickname: row.ml_nickname,
    scope: row.scope,
    status: row.status,
    tokenExpiresAt: row.token_expires_at,
    authorizedAt: row.authorized_at,
    lastRefreshedAt: row.last_refreshed_at,
    lastError: row.last_error,
  };
}

function novoSeller(sellerName: string): SellerRow {
  const now = new Date().toISOString();
  return {
    seller_name: sellerName,
    ml_user_id: null,
    ml_nickname: null,
    access_token_enc: null,
    refresh_token_enc: null,
    scope: null,
    token_expires_at: null,
    authorized_at: null,
    status: "pending",
    last_refreshed_at: null,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
}

export async function listSellers(): Promise<SellerRow[]> {
  const rows = (await getStore().list(SELLERS)) as unknown as SellerRow[];
  return rows.sort((a, b) => a.seller_name.localeCompare(b.seller_name));
}

export async function getSellerByName(sellerName: string): Promise<SellerRow | undefined> {
  return (await getStore().get(SELLERS, sellerName)) as SellerRow | undefined;
}

export async function getSellerByMlUserId(mlUserId: string): Promise<SellerRow | undefined> {
  return (await listSellers()).find((s) => s.ml_user_id === mlUserId);
}

/** Cria (ou retorna) o registro "pending" que antecede a autorização OAuth. */
export async function ensureSellerPlaceholder(sellerName: string): Promise<SellerRow> {
  const existing = await getSellerByName(sellerName);
  if (existing) return existing;
  const row = novoSeller(sellerName);
  await getStore().set(SELLERS, sellerName, { ...row });
  return row;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresInSeconds: number;
  mlUserId: string;
}

/** Persiste tokens novos (autorização inicial ou refresh), sempre cifrados. */
export async function saveTokens(sellerName: string, tokens: TokenSet): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const existing = (await getSellerByName(sellerName)) ?? novoSeller(sellerName);

  const row: SellerRow = {
    ...existing,
    ml_user_id: tokens.mlUserId,
    access_token_enc: encryptSecret(tokens.accessToken),
    refresh_token_enc: encryptSecret(tokens.refreshToken),
    scope: tokens.scope,
    token_expires_at: expiresAt,
    authorized_at: existing.authorized_at ?? now,
    status: "active",
    last_refreshed_at: now,
    last_error: null,
    updated_at: now,
  };
  await getStore().set(SELLERS, sellerName, { ...row });
}

export async function markSellerError(sellerName: string, message: string): Promise<void> {
  if (!(await getSellerByName(sellerName))) return;
  await getStore().merge(SELLERS, sellerName, {
    status: "error",
    last_error: message,
    updated_at: new Date().toISOString(),
  });
}

export async function markSellerRevoked(sellerName: string): Promise<void> {
  if (!(await getSellerByName(sellerName))) return;
  await getStore().merge(SELLERS, sellerName, {
    status: "revoked",
    access_token_enc: null,
    refresh_token_enc: null,
    updated_at: new Date().toISOString(),
  });
}

export async function deleteSeller(sellerName: string): Promise<void> {
  await getStore().delete(SELLERS, sellerName);
}

/** Descriptografa os tokens de um seller. Uso restrito ao TokenManager. */
export function getDecryptedTokens(row: SellerRow): { accessToken: string; refreshToken: string } | null {
  if (!row.access_token_enc || !row.refresh_token_enc) return null;
  return {
    accessToken: decryptSecret(row.access_token_enc),
    refreshToken: decryptSecret(row.refresh_token_enc),
  };
}

// ---- OAuth pending state (state + PKCE) ----

export interface OAuthPendingRow {
  state: string;
  seller_name: string;
  code_verifier: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
}

export async function savePendingAuthorization(params: {
  state: string;
  sellerName: string;
  codeVerifier: string;
  redirectUri: string;
  ttlMinutes?: number;
}): Promise<void> {
  const row: OAuthPendingRow = {
    state: params.state,
    seller_name: params.sellerName,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (params.ttlMinutes ?? 15) * 60_000).toISOString(),
  };
  await getStore().set(OAUTH_PENDING, params.state, { ...row });
}

export async function consumePendingAuthorization(state: string): Promise<OAuthPendingRow | undefined> {
  const row = (await getStore().take(OAUTH_PENDING, state)) as OAuthPendingRow | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return undefined; // expirado
  }
  return row;
}

/**
 * Auditoria leve (sem payloads sensíveis). Vai para o log do processo, que no
 * Cloud Run fica guardado e pesquisável no Cloud Logging — não ocupa o banco.
 */
export function recordAudit(sellerName: string | null, event: string, detail?: string): void {
  auditLog.info({ audit: true, seller: sellerName, event, detail: detail ?? null }, "audit");
}
