// SPDX-License-Identifier: Apache-2.0
/**
 * The intent reads behind the facade (E5.4a): why an accepted command failed, where it stands,
 * and the child-result priority write.
 */
import type { CommandId, ThreadId } from "@ace/protocol";
import type { NativeEngineHandle } from "./contracts.ts";
import { incomplete } from "./contracts.ts";

function member(binding: NativeEngineHandle, name: string): (...args: unknown[]) => unknown {
  const value = binding[name];
  if (typeof value !== "function") throw incomplete(name, "E5.4a");
  return value.bind(binding) as (...args: unknown[]) => unknown;
}

/** `commandFailure`: why an admitted command failed after admission, if it did. */
export function commandFailure(
  binding: NativeEngineHandle,
  commandId: CommandId,
): string | undefined {
  return (member(binding, "commandFailure")(commandId) as string | null) ?? undefined;
}

/** `commandExecution`: the command's intent status. */
export function commandExecution(
  binding: NativeEngineHandle,
  commandId: CommandId,
): string | undefined {
  return (member(binding, "commandExecution")(commandId) as string | null) ?? undefined;
}

/** `prioritizeSubagentResult`: position 0, no revision bump. */
export function prioritizeSubagentResult(
  binding: NativeEngineHandle,
  id: ThreadId,
  commandId: CommandId,
): void {
  member(binding, "prioritizeSubagentResult")(id, commandId);
}
