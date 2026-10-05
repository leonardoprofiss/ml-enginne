import { getStore } from "./db.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";

const BLING_SELLERS = "bling_sellers";
const BLING_OAUTH_PENDING = "bling_oauth_pending";

export type BlingSellerStatus = "pending" | "active" | "expired" | "revoked" | "error";

export interface BlingSellerRow {
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

function novoBlingSeller(sellerName: string): BlingSellerRow {
  const now = new Date().toISOString();
  return {
    seller_name: sellerName,
    bling_user_id: null,
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

export async function listBlingSellers(): Promise<BlingSellerRow[]> {
  const rows = (await getStore().list(BLING_SELLERS)) as unknown as BlingSellerRow[];
  return rows.sort((a, b) => a.seller_name.localeCompare(b.seller_name));
}

export async function getBlingSellerByName(sellerName: string): Promise<BlingSellerRow | undefined> {
  return (await getStore().get(BLING_SELLERS, sellerName)) as BlingSellerRow | undefined;
}

export async function ensureBlingSellerPlaceholder(sellerName: string): Promise<BlingSellerRow> {
  const existing = await getBlingSellerByName(sellerName);
  if (existing) return existing;
  const row = novoBlingSeller(sellerName);
  await getStore().set(BLING_SELLERS, sellerName, { ...row });
  return row;
}

export interface BlingTokenSet {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresInSeconds: number;
  blingUserId?: string;
}

export async function saveBlingTokens(sellerName: string, tokens: BlingTokenSet): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString();
  const now = new Date().toISOString();
  const existing = (await getBlingSellerByName(sellerName)) ?? novoBlingSeller(sellerName);

  const row: BlingSellerRow = {
    ...existing,
    bling_user_id: tokens.blingUserId ?? existing.bling_user_id,
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
  await getStore().set(BLING_SELLERS, sellerName, { ...row });
}

export async function markBlingSellerError(sellerName: string, message: string): Promise<void> {
  if (!(await getBlingSellerByName(sellerName))) return;
  await getStore().merge(BLING_SELLERS, sellerName, {
    status: "error",
    last_error: message,
    updated_at: new Date().toISOString(),
  });
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

export async function saveBlingPendingAuthorization(params: {
  state: string;
  sellerName: string;
  redirectUri: string;
  ttlMinutes?: number;
}): Promise<void> {
  const row: BlingOAuthPendingRow = {
    state: params.state,
    seller_name: params.sellerName,
    redirect_uri: params.redirectUri,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + (params.ttlMinutes ?? 15) * 60_000).toISOString(),
  };
  await getStore().set(BLING_OAUTH_PENDING, params.state, { ...row });
}

export async function consumeBlingPendingAuthorization(state: string): Promise<BlingOAuthPendingRow | undefined> {
  const row = (await getStore().take(BLING_OAUTH_PENDING, state)) as BlingOAuthPendingRow | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return undefined;
  }
  return row;
}
