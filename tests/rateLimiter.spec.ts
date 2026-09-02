import { describe, it, expect } from "vitest";
import { TokenBucket } from "../src/mercadolivre/rateLimiter.js";

describe("TokenBucket", () => {
  it("permite consumir até a capacidade sem esperar", async () => {
    const bucket = new TokenBucket(3, 100);
    const start = Date.now();
    await bucket.acquire();
    await bucket.acquire();
    await bucket.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("bloqueia (aguarda) quando a capacidade é excedida", async () => {
    const bucket = new TokenBucket(1, 20); // 1 token, reabastece 20/s (~50ms por token)
    await bucket.acquire();
    const start = Date.now();
    await bucket.acquire(); // deve esperar
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
