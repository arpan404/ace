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

/**
 * Commands that would start or redirect a turn; a moving or moved thread refuses them
 * (`live-move.ts:13`-`:21`). Every other command, `thread.interrupt` and `thread.archive`
 * included, still runs.
 */
const turnCommands = new Set([
  "thread.send",
  "thread.resume",
  "queue.resume",
  "thread.switch",
  "thread.limit",
  "thread.move",
  "thread.continueOn",
]);

/** What the receipt handler wraps: the engine's policies and the native call. */
export interface ReceiptDeps {
  closing(): boolean;
  ready(): boolean;
  store: Store;
  /** `liveMove.fenceCommand`: a thread fenced to another machine refuses its turn commands. */
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
        const payload = command.payload as { type: string; threadId?: string | null };
        // Only a turn command with a thread id is fenced (`live-move.ts:33`-`:41`); the
        // production fence answers `{code, detail}`, and TS wraps it as a refusal.
        const fenced =
          turnCommands.has(payload.type) && payload.threadId
            ? deps.fence?.(payload.threadId)
            : undefined;
        if (fenced !== undefined && fenced !== null) {
          const refused = fenced as { code: string; detail: string };
          return {
            commandId: command.id,
            ok: false,
            error: refused.code,
            ...refused,
          } as CommandResult;
        }
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
