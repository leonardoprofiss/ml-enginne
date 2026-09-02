/**
 * Rate limiter simples (token bucket) por processo. A ML não publica um
 * número fixo de req/min por endpoint (varia), então usamos um teto
 * conservador e configurável, complementado pelo tratamento de 429 com
 * backoff no cliente HTTP (ver client.ts). Isso evita "bater na API" de
 * contas com 5k+ anúncios de forma descontrolada.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const missing = 1 - this.tokens;
      const waitMs = Math.max(10, Math.ceil((missing / this.refillPerSecond) * 1000));
      await sleep(waitMs);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ~10 req/s por padrão (600/min) com rajada de 20 — ajustável via ambiente se necessário.
export const globalMlBucket = new TokenBucket(20, 10);
