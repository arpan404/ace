import type { StorageReason } from "@ace/protocol";
/** Confirmed refusal before any destructive filesystem effect. */
export class StorageRefusal extends Error {
  readonly reason: StorageReason;
  constructor(reason: StorageReason) {
    super("storage_item_protected");
    this.reason = reason;
  }
}
