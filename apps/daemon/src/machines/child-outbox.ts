import { z } from "zod";
import type { Store } from "../store.ts";

/** One thing a parent must hear about a child on another machine: its result or a notice. */
export interface OutboxEntry {
  /** Names the entry once: queueing the same key again changes nothing. */
  key: string;
  child: string;
  parent: string;
  kind: "result" | "notice";
  text: string;
}
const Entry = z.object({
  key: z.string(),
  child: z.string(),
  parent: z.string(),
  kind: z.enum(["result", "notice"]),
  text: z.string(),
});

/**
 * What the parents of children on other machines are owed, kept until each one has been
 * delivered. A result stays here whatever happens to the child afterwards (reopened, polled
 * again with a new view), so nothing a parent should hear is lost or told twice.
 */
export class ChildOutbox {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS machine_child_outbox (
        key TEXT PRIMARY KEY, child TEXT NOT NULL, parent TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)`),
    );
  }
  queue(entry: OutboxEntry): void {
    this.store.atomic((db) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO machine_child_outbox (key,child,parent,kind,text) VALUES (?,?,?,?,?)",
        )
        .run(entry.key, entry.child, entry.parent, entry.kind, entry.text),
    );
  }
  /** Undelivered entries, oldest first. */
  unsent(): OutboxEntry[] {
    return this.store
      .atomic((db) =>
        db
          .prepare(
            "SELECT key,child,parent,kind,text FROM machine_child_outbox WHERE sent=0 ORDER BY rowid LIMIT 64",
          )
          .all(),
      )
      .map((row) => Entry.parse(row));
  }
  hasUnsent(): boolean {
    return Boolean(
      this.store.atomic((db) =>
        db.prepare("SELECT 1 FROM machine_child_outbox WHERE sent=0 LIMIT 1").get(),
      ),
    );
  }
  sent(key: string): void {
    this.store.atomic((db) =>
      db.prepare("UPDATE machine_child_outbox SET sent=1 WHERE key=?").run(key),
    );
  }
  /** A wait read the child's result inside a tool call: it is not delivered again. */
  resultsRead(child: string): void {
    this.store.atomic((db) =>
      db
        .prepare("UPDATE machine_child_outbox SET sent=1 WHERE child=? AND kind='result'")
        .run(child),
    );
  }
}
