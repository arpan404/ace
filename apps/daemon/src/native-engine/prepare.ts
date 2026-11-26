// SPDX-License-Identifier: Apache-2.0
/**
 * `index.ts:1116`-`:1138`'s `prepareCommand`: wait for the provider and readiness, then run only
 * the ports the command's type runs. A port that would do the work belongs to the item that owns
 * it, so this throws rather than skipping it; archive and interrupt run neither.
 */
import type { Command } from "@ace/protocol";
import type { EngineOptions } from "../engine/engine-options.ts";
import type { Store } from "../store.ts";
import { incomplete, type NativeEngineHandle } from "./contracts.ts";

export interface PrepareDeps {
  options: EngineOptions;
  store: Store;
  ready: Promise<void>;
  binding: NativeEngineHandle;
}

export async function prepareCommand(deps: PrepareDeps, command: Command): Promise<void> {
  const payload = command.payload as {
    provider?: string;
    threadId?: import("@ace/protocol").ThreadId;
    type: string;
  };
  const provider =
    payload.provider ??
    (payload.threadId === undefined ? undefined : deps.store.getThread(payload.threadId)?.provider);
  if (provider !== undefined) await deps.options.waitForProvider?.(provider as never);
  await deps.ready;
  // `silence.prepareCommand` (`silence.ts:83`): create and prepare read the workspace, these
  // read the thread. Archive and interrupt appear in neither list.
  const silenceReads =
    payload.type === "thread.create" ||
    payload.type === "thread.prepare" ||
    (payload.threadId !== undefined &&
      payload.threadId !== null &&
      ["thread.send", "thread.resume", "queue.resume", "thread.limit", "thread.fork"].includes(
        payload.type,
      ));
  if (deps.options.resolveSilenceMs !== undefined && silenceReads)
    throw incomplete("prepareCommand's silence", "E5.6");
  // `recovery.prepare` (`recovery.ts:91`): the port and the defaults it reads are E5.8's.
  if (
    !["thread.create", "thread.send", "thread.resume", "queue.resume", "thread.limit"].includes(
      payload.type,
    )
  )
    return;
  if (deps.options.recovery?.preferences !== undefined || deps.options.preferences !== undefined)
    throw incomplete("prepareCommand's recovery", "E5.8");
  (deps.binding.prepareCommand as ((value: string) => void) | undefined)?.(JSON.stringify(command));
}
