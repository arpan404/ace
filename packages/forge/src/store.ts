import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ForgeThreadLink, ForgeAutoFixIntent } from "@ace/protocol/forge";
import { ForgeError } from "./errors.ts";
import { redactData } from "./redact.ts";

const rowSchema = z.object({ payload: z.string() });
function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const row = rowSchema.safeParse(value);
  if (!row.success) throw new ForgeError("invalid_data");
  try {
    return schema.parse(JSON.parse(row.data.payload));
  } catch {
    throw new ForgeError("invalid_data");
  }
}
/** Caller owns database lifetime. Tables are isolated from daemon migrations. */
export class ForgeStore {
  readonly #db: DatabaseSync;
  readonly #getLink;
  readonly #putLink;
  readonly #seen;
  readonly #admit;
  readonly #pending;
  readonly #ack;
  readonly #count;
  readonly #maxPending: number;
  constructor(db: DatabaseSync, maxPending = 2_000) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 2_000)
      throw new RangeError("Invalid queue cap");
    this.#db = db;
    this.#maxPending = maxPending;
    db.exec(`CREATE TABLE IF NOT EXISTS forge_links (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS forge_intents (thread_id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT, PRIMARY KEY(thread_id,key));
      CREATE INDEX IF NOT EXISTS forge_pending ON forge_intents(thread_id) WHERE payload IS NOT NULL;`);
    this.#getLink = db.prepare("SELECT payload FROM forge_links WHERE thread_id=?");
    this.#putLink = db.prepare(
      "INSERT INTO forge_links VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET payload=excluded.payload",
    );
    this.#seen = db.prepare("SELECT 1 FROM forge_intents WHERE thread_id=? AND key=?");
    this.#admit = db.prepare("INSERT OR IGNORE INTO forge_intents VALUES (?,?,?)");
    this.#pending = db.prepare(
      "SELECT payload FROM forge_intents WHERE thread_id=? AND payload IS NOT NULL ORDER BY rowid LIMIT 32",
    );
    this.#ack = db.prepare("UPDATE forge_intents SET payload=NULL WHERE thread_id=? AND key=?");
    this.#count = db.prepare(
      "SELECT count(*) AS count FROM forge_intents WHERE payload IS NOT NULL",
    );
  }
  link(input: ForgeThreadLink): void {
    const link = ForgeThreadLink.parse(input);
    const current = this.getLink(link.threadId);
    this.#db.exec("SAVEPOINT forge_link");
    try {
      if (current && JSON.stringify(current.pr) !== JSON.stringify(link.pr))
        this.#db.prepare("DELETE FROM forge_intents WHERE thread_id=?").run(link.threadId);
      this.#putLink.run(link.threadId, JSON.stringify(link));
      this.#db.exec("RELEASE forge_link");
    } catch (error) {
      this.#db.exec("ROLLBACK TO forge_link; RELEASE forge_link");
      throw error;
    }
  }
  getLink(threadId: string): ForgeThreadLink | undefined {
    const row = this.#getLink.get(threadId);
    return row === undefined ? undefined : decode(ForgeThreadLink, row);
  }
  unlink(threadId: string): void {
    this.#db.exec("SAVEPOINT forge_unlink");
    try {
      this.#db.prepare("DELETE FROM forge_intents WHERE thread_id=?").run(threadId);
      this.#db.prepare("DELETE FROM forge_links WHERE thread_id=?").run(threadId);
      this.#db.exec("RELEASE forge_unlink");
    } catch (error) {
      this.#db.exec("ROLLBACK TO forge_unlink; RELEASE forge_unlink");
      throw error;
    }
  }
  hasIntent(threadId: string, key: string): boolean {
    return this.#seen.get(threadId, key) !== undefined;
  }
  admit(input: ForgeAutoFixIntent): void {
    const intent = ForgeAutoFixIntent.parse(redactData(input));
    if (this.hasIntent(intent.link.threadId, intent.key)) return;
    const count = z.object({ count: z.number() }).parse(this.#count.get()).count;
    if (count >= this.#maxPending) throw new ForgeError("limit");
    if (JSON.stringify(this.getLink(intent.link.threadId)) !== JSON.stringify(intent.link))
      throw new ForgeError("conflict");
    this.#admit.run(intent.link.threadId, intent.key, JSON.stringify(intent));
  }
  pending(threadId: string): ForgeAutoFixIntent[] {
    return this.#pending.all(threadId).map((row) => decode(ForgeAutoFixIntent, row));
  }
  acknowledge(intent: ForgeAutoFixIntent): void {
    this.#ack.run(intent.link.threadId, intent.key);
  }
}
