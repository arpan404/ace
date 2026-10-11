import { createHash } from "node:crypto";
import { z } from "zod";
import type { ForgeRepository } from "@ace/protocol";
import type { ReplyReceipts } from "@ace/forge";
import type { Store } from "./store.ts";

const receipt = z.object({
  id: z.number().int().positive().nullable(),
  before: z.number().int().nonnegative(),
  account: z.string().max(100),
});
/** Persist only the remote comment ID and nonsecret account, never raw CLI output. */
export class ForgeReplyReceipts {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS forge_reply_receipts (
      scope TEXT NOT NULL, intent TEXT NOT NULL, comment_id INTEGER, before_id INTEGER NOT NULL, account TEXT NOT NULL,
      PRIMARY KEY(scope, intent)
    )`),
    );
  }
  scope(cwd: string, repository: ForgeRepository, account: string): ReplyReceipts {
    const scope = createHash("sha256")
      .update(JSON.stringify([cwd, repository]))
      .digest("hex");
    return {
      account,
      get: (intent) => {
        const row = this.store.atomic((db) =>
          db
            .prepare(
              "SELECT comment_id AS id, before_id AS before, account FROM forge_reply_receipts WHERE scope=? AND intent=?",
            )
            .get(scope, intent),
        );
        return row ? receipt.parse(row) : undefined;
      },
      reserve: (intent, before) =>
        this.store.atomic((db) => {
          if (
            db
              .prepare("SELECT 1 FROM forge_reply_receipts WHERE scope=? AND intent=?")
              .get(scope, intent)
          )
            return false;
          const count = db.prepare("SELECT COUNT(*) AS count FROM forge_reply_receipts").get();
          if (typeof count?.count !== "number" || count.count >= 4096)
            throw new Error("forge_receipt_limit");
          db.prepare(
            "INSERT INTO forge_reply_receipts(scope,intent,comment_id,before_id,account) VALUES (?,?,NULL,?,?)",
          ).run(scope, intent, before, account);
          return true;
        }),
      put: (intent, id) => {
        this.store.atomic((db) =>
          db
            .prepare("UPDATE forge_reply_receipts SET comment_id=? WHERE scope=? AND intent=?")
            .run(id, scope, intent),
        );
      },
      remove: (intent) => {
        this.store.atomic((db) =>
          db
            .prepare("DELETE FROM forge_reply_receipts WHERE scope=? AND intent=?")
            .run(scope, intent),
        );
      },
    };
  }
}
