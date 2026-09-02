import pino from "pino";
import { env } from "../config/env.js";

/**
 * Logger central. REGRA DE OURO: nunca logar access_token, refresh_token,
 * client_secret ou o header Authorization. Os redact paths abaixo cobrem
 * os formatos mais comuns de vazamento acidental (campo direto ou aninhado).
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "access_token",
      "refresh_token",
      "client_secret",
      "*.access_token",
      "*.refresh_token",
      "*.client_secret",
      "*.authorization",
      "*.Authorization",
      "req.headers.authorization",
      "headers.authorization",
      "token",
      "*.token",
    ],
    censor: "[REDACTED]",
  },
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } }
      : undefined,
});

/** Cria um child logger nomeado por módulo (uso: `const log = childLogger("oauth")`). */
export function childLogger(module: string) {
  return logger.child({ module });
}
