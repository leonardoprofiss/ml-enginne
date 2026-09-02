import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/**
 * Criptografia simétrica AES-256-GCM para tokens em repouso.
 * Formato armazenado (string, base64, "." como separador):
 *   <iv>.<authTag>.<ciphertext>
 *
 * A chave (TOKEN_ENCRYPTION_KEY) nunca fica no código-fonte — só em
 * variável de ambiente / secret manager. Ver .env.example.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recomendado para GCM

function getKey(): Buffer {
  const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY inválida: esperado 32 bytes após decode base64, recebido ${key.length}. ` +
        "Gere uma nova com: openssl rand -base64 32"
    );
  }
  return key;
}

export function encryptSecret(plainText: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Payload cifrado malformado (esperado iv.authTag.ciphertext)");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Mascara um token para exibição segura em logs/CLIs (ex.: APP_USR-12...ab34). */
export function maskToken(token: string | null | undefined): string {
  if (!token) return "(vazio)";
  if (token.length <= 10) return "***";
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

/** Gera um `state` aleatório e seguro para o fluxo OAuth (anti-CSRF). */
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

/** Gera o par PKCE (code_verifier, code_challenge) recomendado pela ML. */
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}
