import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("database");
const __dirname = dirname(fileURLToPath(import.meta.url));

let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (dbInstance) return dbInstance;

  const dbPath = resolve(env.DATABASE_PATH);
  mkdirSync(dirname(dbPath), { recursive: true });

  dbInstance = new Database(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");

  const schemaPath = resolve(__dirname, "schema.sql");
  const schema = readFileSync(schemaPath, "utf8");
  dbInstance.exec(schema);

  log.info({ dbPath }, "banco de dados inicializado");
  return dbInstance;
}

export function closeDb(): void {
  dbInstance?.close();
  dbInstance = null;
}
