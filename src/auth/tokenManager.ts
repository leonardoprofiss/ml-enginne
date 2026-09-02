import { childLogger } from "../utils/logger.js";
import {
  getDecryptedTokens,
  getSellerByName,
  markSellerError,
  saveTokens,
  recordAudit,
  type SellerRow,
} from "../database/sellersRepo.js";
import { refreshTokens } from "./oauth.js";

const log = childLogger("token-manager");

// Renova um pouco antes de expirar de fato (margem de segurança).
const EXPIRY_SAFETY_MARGIN_MS = 2 * 60_000; // 2 minutos

// Evita corrida: duas tools chamando o mesmo seller ao mesmo tempo não devem
// disparar dois refresh simultâneos (o refresh_token é de uso único).
const refreshLocks = new Map<string, Promise<string>>();

export class SellerNotFoundError extends Error {
  constructor(sellerName: string) {
    super(`Seller "${sellerName}" não encontrado. Use listar_contas() para ver os sellers configurados.`);
    this.name = "SellerNotFoundError";
  }
}

export class SellerNotAuthorizedError extends Error {
  constructor(sellerName: string, status: string) {
    super(
      `Seller "${sellerName}" está com status "${status}" — a autorização OAuth ainda não foi concluída ou foi revogada. ` +
        `Rode: npm run oauth:add-seller -- ${sellerName}`
    );
    this.name = "SellerNotAuthorizedError";
  }
}

function isExpiringSoon(row: SellerRow): boolean {
  if (!row.token_expires_at) return true;
  return new Date(row.token_expires_at).getTime() - EXPIRY_SAFETY_MARGIN_MS <= Date.now();
}

/**
 * Retorna um access_token válido para o seller, renovando automaticamente
 * via refresh_token quando necessário. Nunca retorna token expirado.
 */
export async function getValidAccessToken(sellerName: string): Promise<string> {
  const row = getSellerByName(sellerName);
  if (!row) throw new SellerNotFoundError(sellerName);
  if (row.status === "revoked" || row.status === "pending") {
    throw new SellerNotAuthorizedError(sellerName, row.status);
  }

  const tokens = getDecryptedTokens(row);
  if (!tokens) throw new SellerNotAuthorizedError(sellerName, row.status);

  if (!isExpiringSoon(row)) {
    return tokens.accessToken;
  }

  // já existe um refresh em andamento para este seller? reaproveita a promise.
  const inFlight = refreshLocks.get(sellerName);
  if (inFlight) return inFlight;

  const refreshPromise = (async () => {
    try {
      log.info({ sellerName }, "renovando access_token");
      const fresh = await refreshTokens(tokens.refreshToken);
      saveTokens(sellerName, fresh);
      recordAudit(sellerName, "token_refreshed");
      return fresh.accessToken;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markSellerError(sellerName, message);
      recordAudit(sellerName, "token_refresh_failed", message);
      log.error({ sellerName, err: message }, "falha ao renovar token");
      throw err;
    } finally {
      refreshLocks.delete(sellerName);
    }
  })();

  refreshLocks.set(sellerName, refreshPromise);
  return refreshPromise;
}
