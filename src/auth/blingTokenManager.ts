import { childLogger } from "../utils/logger.js";
import {
  getDecryptedBlingTokens,
  getBlingSellerByName,
  markBlingSellerError,
  saveBlingTokens,
  type BlingSellerRow,
} from "../database/blingSellersRepo.js";
import { refreshBlingTokens } from "./oauthBling.js";

const log = childLogger("token-manager-bling");

const EXPIRY_SAFETY_MARGIN_MS = 2 * 60_000;
const refreshLocks = new Map<string, Promise<string>>();

export class BlingSellerNotFoundError extends Error {
  constructor(sellerName: string) {
    super(`Conta Bling "${sellerName}" não encontrada.`);
    this.name = "BlingSellerNotFoundError";
  }
}

export class BlingSellerNotAuthorizedError extends Error {
  constructor(sellerName: string, status: string) {
    super(
      `Conta Bling "${sellerName}" está com status "${status}". Abra /oauth/bling/start?seller=${sellerName} para (re)autorizar.`
    );
    this.name = "BlingSellerNotAuthorizedError";
  }
}

function isExpiringSoon(row: BlingSellerRow): boolean {
  if (!row.token_expires_at) return true;
  return new Date(row.token_expires_at).getTime() - EXPIRY_SAFETY_MARGIN_MS <= Date.now();
}

export async function getValidBlingAccessToken(sellerName: string): Promise<string> {
  const row = getBlingSellerByName(sellerName);
  if (!row) throw new BlingSellerNotFoundError(sellerName);
  if (row.status === "revoked" || row.status === "pending") {
    throw new BlingSellerNotAuthorizedError(sellerName, row.status);
  }

  const tokens = getDecryptedBlingTokens(row);
  if (!tokens) throw new BlingSellerNotAuthorizedError(sellerName, row.status);

  if (!isExpiringSoon(row)) return tokens.accessToken;

  const inFlight = refreshLocks.get(sellerName);
  if (inFlight) return inFlight;

  const refreshPromise = (async () => {
    try {
      log.info({ sellerName }, "renovando access_token bling");
      const fresh = await refreshBlingTokens(tokens.refreshToken);
      saveBlingTokens(sellerName, fresh);
      return fresh.accessToken;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markBlingSellerError(sellerName, message);
      throw err;
    } finally {
      refreshLocks.delete(sellerName);
    }
  })();

  refreshLocks.set(sellerName, refreshPromise);
  return refreshPromise;
}
