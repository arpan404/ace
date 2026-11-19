import type { Store } from "../store.ts";
import { livePendingTable } from "./live/target-rows.ts";
import { TransferIndex } from "./transfer-index.ts";

/*
 * The receiving side's index (see transfer-index.ts): `transfer_incoming_open` holds transfers
 * still receiving, cloning or importing, and settled ones whose rollback a crash cut short;
 * `transfer_incoming_expiry` the rest, receiving included, from their last change.
 */

const unsettled = new Set(["receiving", "cloning", "importing"]);
const expiring = new Set(["receiving", "completed", "failed", "cancelled"]);

export class IncomingIndex extends TransferIndex {
  constructor(store: Store) {
    store.atomic((db) => db.exec(livePendingTable));
    super(store, {
      table: "transfer_incoming",
      columns: "state, registered_id, created_path, updated_at",
      opens: (row) => {
        const state = String(row["state"]);
        if (unsettled.has(state)) return true;
        return (
          (state === "failed" || state === "cancelled") &&
          (row["registered_id"] !== null || row["created_path"] !== null)
        );
      },
      expiresAt: (row) =>
        expiring.has(String(row["state"])) ? Number(row["updated_at"]) : undefined,
    });
  }
}
