// SPDX-License-Identifier: Apache-2.0
/**
 * The receipt's shell half (E5.4d): the one `store.atomic` around the fence, the host
 * interactions and the command policy, with the native receipt inside it, and
 * `prepareCommand`'s provider and readiness waits.
 */
import type { CommandResult } from "@ace/protocol";
import type { CommandHandler } from "../commands.ts";
import type { Store } from "../store.ts";

export type Receipt = (command: string) => string;

/** What the receipt handler wraps: the engine's policies and the native call. */
export interface ReceiptDeps {
  closing(): boolean;
  ready(): boolean;
  store: Store;
  host?: ((command: unknown) => unknown) | undefined;
  policy?: ((command: unknown, accept: () => unknown) => unknown) | undefined;
  receipt: Receipt;
}

/** `internalHandler.handle`: the receipt inside the shell's one transaction. */
export function receiptHandler(deps: ReceiptDeps): CommandHandler {
  return {
    handle: (command, _context) => {
      if (deps.closing())
        return { commandId: command.id, ok: false, error: "daemon_shutting_down" };
      if (!deps.ready()) return { commandId: command.id, ok: false, error: "engine_starting" };
      const receipt = () => JSON.parse(deps.receipt(JSON.stringify(command))) as CommandResult;
      return deps.store.atomic(() => {
        const hosted = deps.host?.(command);
        if (hosted !== undefined) return hosted as CommandResult;
        const decided = deps.policy?.(command, () => receipt());
        return (decided ?? receipt()) as CommandResult;
      });
    },
  };
}
