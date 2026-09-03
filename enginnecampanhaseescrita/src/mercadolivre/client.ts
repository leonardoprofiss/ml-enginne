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
  /** Headers extras (ex.: `Api-Version` exigido pela API de Publicidade/Advertising). */
  headers?: Record<string, string>;
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
          ...options.headers,
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
        throw new MlApiError(res.status, body?.error, formatMlErrorMessage(body, res.status, path), path);
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

export interface MlMutationOptions {
  /** Query params (serializados automaticamente). */
  query?: Record<string, string | number | boolean | undefined>;
  /** Timeout específico em ms (default REQUEST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Headers extras (ex.: `Api-Version` exigido pela API de Publicidade/Advertising). */
  headers?: Record<string, string>;
  /**
   * Tentativas extras em caso de erro de rede/5xx/429. Default 0 (nenhum
   * retry): reexecutar uma mutação às cegas pode duplicar um recurso (ex.:
   * criar o mesmo anúncio duas vezes se o timeout estourou depois da ML já
   * ter processado). `mlPut` usa um default maior porque PUT aqui sempre
   * define um estado final (idempotente) — repetir não causa efeito colateral.
   */
  maxRetries?: number;
}

/** Extrai uma mensagem de erro legível do corpo de erro da ML, incluindo `cause` (ex.: atributos obrigatórios faltando ao criar/editar um anúncio). */
function formatMlErrorMessage(body: any, status: number, path: string): string {
  const base = body?.message ?? body?.error_description ?? `Erro ${status} em ${path}`;
  if (Array.isArray(body?.cause) && body.cause.length > 0) {
    const causes = body.cause.map((c: any) => c?.message ?? c?.code ?? JSON.stringify(c)).join("; ");
    return `${base} — detalhes: ${causes}`;
  }
  return base;
}

async function mlMutate<T>(
  method: "POST" | "PUT" | "DELETE",
  sellerName: string,
  path: string,
  body: unknown,
  options: MlMutationOptions = {}
): Promise<T> {
  const accessToken = await getValidAccessToken(sellerName);
  const url = new URL(path.startsWith("http") ? path : `${env.ML_API_BASE_URL}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const maxRetries = options.maxRetries ?? 0;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= maxRetries) {
    await globalMlBucket.acquire();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : backoffMs(attempt);
        log.warn({ path, method, attempt, retryAfterMs }, "429 recebido em mutação, aplicando backoff");
        if (attempt === maxRetries) throw new MlRateLimitError(path, retryAfterMs);
        await sleep(retryAfterMs);
        attempt++;
        continue;
      }

      if (res.status >= 500) {
        log.warn({ path, method, status: res.status, attempt }, "erro 5xx da API ML em mutação");
        if (attempt === maxRetries) {
          throw new MlApiError(res.status, undefined, `Erro ${res.status} do servidor Mercado Livre em ${method} ${path}`, path);
        }
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }

      if (!res.ok) {
        const errBody = await safeJson(res);
        throw new MlApiError(res.status, errBody?.error, formatMlErrorMessage(errBody, res.status, path), path);
      }

      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;

      if (err instanceof MlApiError) throw err;

      if (attempt === maxRetries) break;
      log.warn({ path, method, attempt, err: String(err) }, "erro de rede/timeout em mutação, retry");
      await sleep(backoffMs(attempt));
      attempt++;
    }
  }

  throw new MlApiError(0, "network_error", `Falha de rede/timeout ao chamar ${method} ${path}: ${String(lastError)}`, path);
}

/**
 * POST — cria um recurso (ex.: um novo anúncio). SEM retry automático por
 * padrão: se a chamada falhar por timeout/rede, não temos como saber se a ML
 * já processou ou não, então repetir sozinho arrisca criar o recurso duas
 * vezes. Em caso de erro, a tool deve reportar e deixar quem chamou decidir
 * se tenta de novo (e nesse caso, checar antes se o recurso já foi criado).
 */
export function mlPost<T>(
  sellerName: string,
  path: string,
  body: unknown,
  options: MlMutationOptions = {}
): Promise<T> {
  return mlMutate<T>("POST", sellerName, path, body, options);
}

/**
 * PUT — atualiza um recurso para um estado final (idempotente: enviar o
 * mesmo corpo de novo não tem efeito colateral). Por isso, ao contrário do
 * `mlPost`, tem retry automático por padrão em erro de rede/5xx/429.
 */
export function mlPut<T>(
  sellerName: string,
  path: string,
  body: unknown,
  options: MlMutationOptions = {}
): Promise<T> {
  return mlMutate<T>("PUT", sellerName, path, body, { maxRetries: 3, ...options });
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
