import { CommandId, type CommandResult } from "@ace/protocol";
import type { Store } from "./store.ts";
/** Extend the caller's journal transaction; never replace a receipt already delivered to a client. */
export function completePendingForgeReceipt(
  store: Store,
  id: string,
  outcome: Omit<CommandResult, "commandId">,
): void {
  const commandId = CommandId.parse(id);
  store.atomic((db) => {
    if (
      db
        .prepare(
          "SELECT 1 FROM command_receipts WHERE command_id=? AND json_extract(result,'$.error')='client_action_pending'",
        )
        .get(id)
    )
      store.completeAsyncCommand(commandId, { commandId, ...outcome });
  });
}
