import { Firestore } from "@google-cloud/firestore";
import { env } from "../config/env.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("database");

/**
 * Armazenamento do Enginne.
 *
 * Antes era um arquivo SQLite em disco (volume do Railway). No Cloud Run o
 * disco é apagado a cada reinício, então os dados passaram para o Firestore,
 * o banco de documentos do próprio Google Cloud (sem servidor para manter).
 *
 * Cada "tabela" antiga virou uma coleção, e cada linha virou um documento:
 *   sellers, oauth_pending, bling_sellers, bling_oauth_pending
 *
 * DATA_STORE=memory guarda tudo só na memória do processo. Serve apenas para
 * desenvolvimento e testes: os dados somem quando o processo reinicia.
 */
export type Doc = Record<string, unknown>;

export interface Store {
  readonly kind: "firestore" | "memory";
  get(collection: string, id: string): Promise<Doc | undefined>;
  /** Grava o documento inteiro (substitui o que existir). */
  set(collection: string, id: string, data: Doc): Promise<void>;
  /** Altera só os campos enviados; cria o documento se não existir. */
  merge(collection: string, id: string, data: Doc): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  /** Lê e apaga numa única operação (uso único, ex.: state do OAuth). */
  take(collection: string, id: string): Promise<Doc | undefined>;
  list(collection: string): Promise<Doc[]>;
  ping(): Promise<void>;
}

class MemoryStore implements Store {
  readonly kind = "memory" as const;
  private data = new Map<string, Map<string, Doc>>();

  private col(name: string): Map<string, Doc> {
    let col = this.data.get(name);
    if (!col) {
      col = new Map();
      this.data.set(name, col);
    }
    return col;
  }
  async get(collection: string, id: string): Promise<Doc | undefined> {
    const doc = this.col(collection).get(id);
    return doc ? { ...doc } : undefined;
  }
  async set(collection: string, id: string, data: Doc): Promise<void> {
    this.col(collection).set(id, { ...data });
  }
  async merge(collection: string, id: string, data: Doc): Promise<void> {
    this.col(collection).set(id, { ...(this.col(collection).get(id) ?? {}), ...data });
  }
  async delete(collection: string, id: string): Promise<void> {
    this.col(collection).delete(id);
  }
  async take(collection: string, id: string): Promise<Doc | undefined> {
    const doc = await this.get(collection, id);
    this.col(collection).delete(id);
    return doc;
  }
  async list(collection: string): Promise<Doc[]> {
    return [...this.col(collection).values()].map((d) => ({ ...d }));
  }
  async ping(): Promise<void> {}
}

class FirestoreStore implements Store {
  readonly kind = "firestore" as const;
  private db: Firestore;

  constructor() {
    // No Cloud Run, projeto e credenciais são detectados automaticamente.
    this.db = new Firestore({
      ignoreUndefinedProperties: true,
      ...(env.FIRESTORE_DATABASE_ID ? { databaseId: env.FIRESTORE_DATABASE_ID } : {}),
    });
  }
  private ref(collection: string, id: string) {
    return this.db.collection(`${env.FIRESTORE_COLLECTION_PREFIX}${collection}`).doc(id);
  }
  async get(collection: string, id: string): Promise<Doc | undefined> {
    const snap = await this.ref(collection, id).get();
    return snap.exists ? (snap.data() as Doc) : undefined;
  }
  async set(collection: string, id: string, data: Doc): Promise<void> {
    await this.ref(collection, id).set(data);
  }
  async merge(collection: string, id: string, data: Doc): Promise<void> {
    await this.ref(collection, id).set(data, { merge: true });
  }
  async delete(collection: string, id: string): Promise<void> {
    await this.ref(collection, id).delete();
  }
  async take(collection: string, id: string): Promise<Doc | undefined> {
    const ref = this.ref(collection, id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      tx.delete(ref);
      return snap.data() as Doc;
    });
  }
  async list(collection: string): Promise<Doc[]> {
    const snap = await this.db.collection(`${env.FIRESTORE_COLLECTION_PREFIX}${collection}`).get();
    return snap.docs.map((d) => d.data() as Doc);
  }
  async ping(): Promise<void> {
    await this.ref("sellers", "__ping__").get();
  }
}

let storeInstance: Store | null = null;

export function getStore(): Store {
  if (storeInstance) return storeInstance;
  storeInstance = env.DATA_STORE === "memory" ? new MemoryStore() : new FirestoreStore();
  log.info({ store: storeInstance.kind }, "armazenamento inicializado");
  return storeInstance;
}
