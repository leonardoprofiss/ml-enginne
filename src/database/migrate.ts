import { getStore } from "./db.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("migrate");

// Com o Firestore não existe schema para criar: as coleções nascem sozinhas
// no primeiro documento gravado. Este comando só confere se o banco responde.
await getStore().ping();
log.info("armazenamento respondendo — nada a migrar");
process.exit(0);
