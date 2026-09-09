import { getDb } from "./db.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";

export type BlingSellerStatus = "pending" | "active" | "expired" | "revoked" | "error";

export interface BlingSellerRow {
  id: number;
  seller_name: string;
  bling_user_id: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  scope: string | null;
  token_expires_at: string | null;
  authorized_at: string | null;
  status: BlingSellerStatus;
  last_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function listBlingSellers(): BlingSellerRow[] {
  return getDb().prepare("SELECT * FROM bling_sellers ORDER BY seller_name ASC").all() as BlingSellerRow[];
}

export function getBlingSellerByName(sellerName: string): BlingSellerRow | undefined {
  return getDb()
    .prepare("SELECT * FROM bling_sellers WHERE seller_name = ?")
    .get(sellerName) as BlingSellerRow | undefined;
}

export function ensureBlingSellerPlaceholder(sellerName: string): BlingSellerRow {
  const existing = getBlingSellerByName(sellerName);
  if (existing) return existing;
  const db = getDb();
  db.prepare(`INSERT INTO bling_sellers (seller_name, status) VALUES (?, 'pending')`).run(sellerName);
  return getBlingSellerByName(sellerName)!;
}

export interface BlingTokenSet {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresInSeconds: number;
  blingUserId?: string;
}

export function saveBlingTokens(sellerName: string, tokens: BlingTokenSet): void {
  const db = getDb();
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const existing = getBlingSellerByName(sellerName);

  db.prepare(
    `UPDATE bling_sellers SET
       bling_user_id = COALESCE(?, bling_user_id),
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
    tokens.blingUserId ?? null,
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

export function markBlingSellerError(sellerName: string, message: string): void {
  getDb()
    .prepare(`UPDATE bling_sellers SET status = 'error', last_error = ?, updated_at = ? WHERE seller_name = ?`)
    .run(message, new Date().toISOString(), sellerName);
}

export function getDecryptedBlingTokens(row: BlingSellerRow): { accessToken: string; refreshToken: string } | null {
  if (!row.access_token_enc || !row.refresh_token_enc) return null;
  return {
    accessToken: decryptSecret(row.access_token_enc),
    refreshToken: decryptSecret(row.refresh_token_enc),
  };
}

export interface BlingOAuthPendingRow {
  state: string;
  seller_name: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
}

export function saveBlingPendingAuthorization(params: {
  state: string;
  sellerName: string;
  redirectUri: string;
  ttlMinutes?: number;
}): void {
  const expiresAt = new Date(Date.now() + (params.ttlMinutes ?? 15) * 60_000).toISOString();
  getDb()
    .prepare(`INSERT INTO bling_oauth_pending (state, seller_name, redirect_uri, expires_at) VALUES (?, ?, ?, ?)`)
    .run(params.state, params.sellerName, params.redirectUri, expiresAt);
}

export function consumeBlingPendingAuthorization(state: string): BlingOAuthPendingRow | undefined {
  const db = getDb();
  const row = db.prepare("SELECT * FROM bling_oauth_pending WHERE state = ?").get(state) as
    | BlingOAuthPendingRow
    | undefined;
  if (!row) return undefined;
  db.prepare("DELETE FROM bling_oauth_pending WHERE state = ?").run(state);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return undefined;
  }
  return row;
}
