import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import { StorageUsage } from "@ace/protocol";
import type { Store } from "../store.ts";

export const USAGE_INTERVAL = 4 * 60 * 60 * 1000;
export const USAGE_PARTIAL_RETRY = 15 * 60 * 1000;
const record = z.object({
  document: z
    .string()
    .max(2 * 1024 * 1024)
    .nullable(),
  due: z.number().int().nonnegative(),
});
/** A root and host binding prevents a copied database from serving another host's measurements. */
export class UsageCache {
  private store: Store;
  private key: string;
  constructor(store: Store, root: string, host = hostname()) {
    this.store = store;
    this.key = createHash("sha256")
      .update(JSON.stringify([resolve(root), host]))
      .digest("hex");
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS storage_usage_cache (
      binding TEXT PRIMARY KEY, document TEXT, due INTEGER NOT NULL)`),
    );
  }
  load(now: number): { usage?: StorageUsage; due: number } {
    const row = record.safeParse(
      this.store
        .statement("SELECT document,due FROM storage_usage_cache WHERE binding=?")
        .get(this.key),
    );
    if (row.success) {
      try {
        const usage = StorageUsage.parse(JSON.parse(row.data.document ?? "null"));
        return { usage, due: row.data.due };
      } catch {
        /* Invalid snapshots never become display data. */
      }
    }
    this.save(undefined, now);
    return { due: now };
  }
  save(usage: StorageUsage | undefined, due: number): void {
    const document = usage === undefined ? null : JSON.stringify(StorageUsage.parse(usage));
    this.store.atomic(() =>
      this.store
        .statement(`INSERT INTO storage_usage_cache VALUES(?,?,?)
      ON CONFLICT(binding) DO UPDATE SET document=excluded.document,due=excluded.due`)
        .run(this.key, document, due),
    );
  }
}
