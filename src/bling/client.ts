import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";
import { getValidBlingAccessToken } from "../auth/blingTokenManager.js";

const log = childLogger("bling-client");
const REQUEST_TIMEOUT_MS = 20_000;

export class BlingApiError extends Error {
  constructor(public status: number, public code: string | undefined, message: string, public path: string) {
    super(message);
    this.name = "BlingApiError";
  }
}

async function blingRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  sellerName: string,
  path: string,
  options: { query?: Record<string, string | number | undefined>; body?: unknown } = {}
): Promise<T> {
  const accessToken = await getValidBlingAccessToken(sellerName);
  const url = new URL(path.startsWith("http") ? path : `${env.BLING_API_BASE_URL}${path}`);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await safeJson(res);
      const code = errBody?.error?.type ?? errBody?.error?.code ?? String(res.status);
      const message = errBody?.error?.message ?? errBody?.message ?? `Erro ${res.status} do Bling em ${method} ${path}`;
      log.warn({ path, method, status: res.status, code }, "erro da API bling");
      throw new BlingApiError(res.status, code, message, path);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof BlingApiError) throw err;
    throw new BlingApiError(0, "network_error", `Falha de rede/timeout ao chamar ${method} ${path}: ${String(err)}`, path);
  }
}

export function blingGet<T>(sellerName: string, path: string, query?: Record<string, string | number | undefined>): Promise<T> {
  return blingRequest<T>("GET", sellerName, path, { query });
}

export function blingPost<T>(sellerName: string, path: string, body: unknown): Promise<T> {
  return blingRequest<T>("POST", sellerName, path, { body });
}

export function blingPut<T>(sellerName: string, path: string, body: unknown): Promise<T> {
  return blingRequest<T>("PUT", sellerName, path, { body });
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
