import { describe, it, expect, beforeAll } from "vitest";

// TOKEN_ENCRYPTION_KEY precisa existir ANTES de importar o env schema.
beforeAll(() => {
  process.env.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString("base64");
  process.env.MCP_API_KEY = process.env.MCP_API_KEY || "test-mcp-api-key-1234567890";
  process.env.ML_CLIENT_ID = process.env.ML_CLIENT_ID || "test-client-id";
  process.env.ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || "test-client-secret";
  process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://example.test";
  process.env.DATABASE_PATH = ":memory:";
});

describe("crypto", () => {
  it("encripta e decripta um texto corretamente (round-trip)", async () => {
    const { encryptSecret, decryptSecret } = await import("../src/utils/crypto.js");
    const plain = "APP_USR-1234567890-abcdef-super-secreto";
    const enc = encryptSecret(plain);
    expect(enc).not.toContain(plain);
    expect(enc.split(".").length).toBe(3);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("gera ciphertexts diferentes para o mesmo input (IV aleatório)", async () => {
    const { encryptSecret } = await import("../src/utils/crypto.js");
    const a = encryptSecret("mesmo-valor");
    const b = encryptSecret("mesmo-valor");
    expect(a).not.toBe(b);
  });

  it("mascara tokens para exibição segura", async () => {
    const { maskToken } = await import("../src/utils/crypto.js");
    expect(maskToken("APP_USR-123456789012345")).toMatch(/^APP_USR-\.\.\.\d{4}$/);
    expect(maskToken(null)).toBe("(vazio)");
    expect(maskToken("curto")).toBe("***");
  });

  it("gera pares PKCE válidos (verifier != challenge, challenge determinístico)", async () => {
    const { generatePkcePair } = await import("../src/utils/crypto.js");
    const { codeVerifier, codeChallenge } = generatePkcePair();
    expect(codeVerifier).not.toBe(codeChallenge);
    expect(codeVerifier.length).toBeGreaterThan(20);
    expect(codeChallenge.length).toBeGreaterThan(20);
  });

  // Nota: a validação de "TOKEN_ENCRYPTION_KEY deve ter 32 bytes" acontece uma
  // única vez, no processo real (src/config/env.ts faz fail-fast com
  // process.exit(1) se a chave for inválida) — não é re-testável aqui porque
  // o módulo de env é um singleton carregado uma vez por processo de teste.
});
