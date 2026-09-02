import { getDb } from "./db.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";

export type SellerStatus = "pending" | "active" | "expired" | "revoked" | "error";

export interface SellerRow {
  id: number;
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

export function listSellers(): SellerRow[] {
  return getDb().prepare("SELECT * FROM sellers ORDER BY seller_name ASC").all() as SellerRow[];
}

export function getSellerByName(sellerName: string): SellerRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sellers WHERE seller_name = ?")
    .get(sellerName) as SellerRow | undefined;
}

export function getSellerByMlUserId(mlUserId: string): SellerRow | undefined {
  return getDb()
    .prepare("SELECT * FROM sellers WHERE ml_user_id = ?")
    .get(mlUserId) as SellerRow | undefined;
}

/** Cria (ou retorna) o registro "pending" que antecede a autorização OAuth. */
export function ensureSellerPlaceholder(sellerName: string): SellerRow {
  const existing = getSellerByName(sellerName);
  if (existing) return existing;
  const db = getDb();
  db.prepare(
    `INSERT INTO sellers (seller_name, status) VALUES (?, 'pending')`
  ).run(sellerName);
  return getSellerByName(sellerName)!;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresInSeconds: number;
  mlUserId: string;
}

/** Persiste tokens novos (autorização inicial ou refresh), sempre cifrados. */
export function saveTokens(sellerName: string, tokens: TokenSet): void {
  const db = getDb();
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const existing = getSellerByName(sellerName);

  db.prepare(
    `UPDATE sellers SET
       ml_user_id = ?,
       access_token_enc = ?,
       refresh_token_enc = ?,
       scope = ?,
       token_expires_at = ?,
       authorized_at = COALESCE(authorized_at, ?),
       status = 'active',
       last_refreshed_at = ?,
       last_error = NULL,
       updated_at = ?
     WHERE seller_name = ?`
  ).run(
    tokens.mlUserId,
    encryptSecret(tokens.accessToken),
    encryptSecret(tokens.refreshToken),
    tokens.scope,
    expiresAt,
    existing?.authorized_at ?? now,
    now,
    now,
    sellerName
  );
}

export function markSellerError(sellerName: string, message: string): void {
  getDb()
    .prepare(
      `UPDATE sellers SET status = 'error', last_error = ?, updated_at = ? WHERE seller_name = ?`
    )
    .run(message, new Date().toISOString(), sellerName);
}

export function markSellerRevoked(sellerName: string): void {
  getDb()
    .prepare(
      `UPDATE sellers SET status = 'revoked', access_token_enc = NULL, refresh_token_enc = NULL, updated_at = ? WHERE seller_name = ?`
    )
    .run(new Date().toISOString(), sellerName);
}

export function deleteSeller(sellerName: string): void {
  getDb().prepare("DELETE FROM sellers WHERE seller_name = ?").run(sellerName);
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

export function savePendingAuthorization(params: {
  state: string;
  sellerName: string;
  codeVerifier: string;
  redirectUri: string;
  ttlMinutes?: number;
}): void {
  const expiresAt = new Date(Date.now() + (params.ttlMinutes ?? 15) * 60_000).toISOString();
  getDb()
    .prepare(
      `INSERT INTO oauth_pending (state, seller_name, code_verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(params.state, params.sellerName, params.codeVerifier, params.redirectUri, expiresAt);
}

export function consumePendingAuthorization(state: string): OAuthPendingRow | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM oauth_pending WHERE state = ?").get(state) as
    | OAuthPendingRow
    | undefined;
  if (!row) return undefined;
  db.prepare("DELETE FROM oauth_pending WHERE state = ?").run(state);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return undefined; // expirado
  }
  return row;
}

export function recordAudit(sellerName: string | null, event: string, detail?: string): void {
  getDb()
    .prepare("INSERT INTO audit_log (seller_name, event, detail) VALUES (?, ?, ?)")
    .run(sellerName, event, detail ?? null);
}
