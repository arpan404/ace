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
  /** `liveMove.fenceCommand`: a thread fenced to another machine refuses every command. */
  fence?: ((threadId: string) => unknown) | undefined;
  host?: ((command: unknown) => unknown) | undefined;
  policy?: ((command: unknown, accept: () => unknown) => unknown) | undefined;
  /** `sessions.commanded` (`index.ts:429`), for an accepted access change. */
  commanded?: ((command: unknown) => void) | undefined;
  receipt: Receipt;
}

/** `internalHandler.handle`: the receipt inside the shell's one transaction. */
export function receiptHandler(deps: ReceiptDeps): CommandHandler {
  return {
    handle: (command, _context) => {
      if (deps.closing())
        return { commandId: command.id, ok: false, error: "daemon_shutting_down" };
      if (!deps.ready()) return { commandId: command.id, ok: false, error: "engine_starting" };
      // One native receipt per command, whether the policy accepts, decides, or both.
      let accepted: CommandResult | undefined;
      const receipt = (): CommandResult =>
        (accepted ??= JSON.parse(deps.receipt(JSON.stringify(command))) as CommandResult);
      const result = deps.store.atomic(() => {
        const threadId = (command.payload as { threadId?: string }).threadId;
        // `??`, as `index.ts:421`-`:426` has it: a null answer falls through.
        const fenced = threadId === undefined ? undefined : deps.fence?.(threadId);
        if (fenced !== undefined && fenced !== null) return fenced as CommandResult;
        const hosted = deps.host?.(command);
        if (hosted !== undefined && hosted !== null) return hosted as CommandResult;
        const decided = deps.policy?.(command, receipt);
        return (decided ?? receipt()) as CommandResult;
      });
      if (result.ok) deps.commanded?.(command);
      return result;
    },
  };
}
