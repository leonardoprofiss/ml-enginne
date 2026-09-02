import { getDb } from "./db.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("migrate");

// getDb() já aplica o schema.sql (idempotente, usa CREATE TABLE IF NOT EXISTS).
// Este script serve como comando explícito `npm run db:migrate` para setup/CI.
getDb();
log.info("migração aplicada com sucesso (schema idempotente)");
process.exit(0);
