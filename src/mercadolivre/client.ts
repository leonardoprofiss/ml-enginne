import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { getValidAccessToken } from "../auth/tokenManager.js";
import { MlApiError, MlRateLimitError } from "./errors.js";
import { globalMlBucket, sleep } from "./rateLimiter.js";

const log = childLogger("ml-client");

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 20_000;

export interface MlRequestOptions {
  /** Query params (serializados automaticamente). */
  query?: Record<string, string | number | boolean | undefined>;
  /** Timeout específico em ms (default REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
}

/**
 * Cliente HTTP central para a API do Mercado Livre. Toda tool passa por
 * aqui — nunca chama fetch diretamente. Responsabilidades:
 *  - injeta Authorization: Bearer <access_token> do seller certo
 *  - aplica rate limiting local (token bucket)
 *  - trata 429/5xx com retry + backoff exponencial + jitter
 *  - nunca loga o token
 */
export async function mlGet<T>(
  sellerName: string,
  path: string,
  options: MlRequestOptions = {}
): Promise<T> {
  const accessToken = await getValidAccessToken(sellerName);
  const url = new URL(path.startsWith("http") ? path : `${env.ML_API_BASE_URL}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= MAX_RETRIES) {
    await globalMlBucket.acquire();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : backoffMs(attempt);
        log.warn({ path, attempt, retryAfterMs }, "429 recebido, aplicando backoff");
        if (attempt === MAX_RETRIES) throw new MlRateLimitError(path, retryAfterMs);
        await sleep(retryAfterMs);
        attempt++;
        continue;
      }

      if (res.status >= 500) {
        log.warn({ path, status: res.status, attempt }, "erro 5xx da API ML, retry");
        if (attempt === MAX_RETRIES) {
          throw new MlApiError(res.status, undefined, `Erro ${res.status} do servidor Mercado Livre em ${path}`, path);
        }
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }

      if (!res.ok) {
        const body = await safeJson(res);
        throw new MlApiError(
          res.status,
          body?.error,
          body?.message ?? body?.error_description ?? `Erro ${res.status} em ${path}`,
          path
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;

      if (err instanceof MlApiError) throw err;

      // timeout/abort ou erro de rede: retry com backoff
      if (attempt === MAX_RETRIES) break;
      log.warn({ path, attempt, err: String(err) }, "erro de rede/timeout, retry");
      await sleep(backoffMs(attempt));
      attempt++;
    }
  }

  throw new MlApiError(0, "network_error", `Falha de rede/timeout ao chamar ${path}: ${String(lastError)}`, path);
}

function backoffMs(attempt: number): number {
  const exp = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.random() * 250;
  return Math.min(exp + jitter, 15_000);
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
