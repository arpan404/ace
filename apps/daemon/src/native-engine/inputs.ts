// SPDX-License-Identifier: Apache-2.0
/**
 * The input reads behind the facade (E5.4c): `inputFate`, over the binding's JSON.
 */
import type { CommandId, ThreadId } from "@ace/protocol";
import type { InputFate } from "../engine/input-fate.ts";
import type { NativeEngineHandle } from "./contracts.ts";
import { incomplete } from "./contracts.ts";

function member(binding: NativeEngineHandle, name: string): (...args: unknown[]) => unknown {
  const value = binding[name];
  if (typeof value !== "function") throw incomplete(name, "E5.4c");
  return value.bind(binding) as (...args: unknown[]) => unknown;
}

/** `inputFate`: what became of input `commandId` in thread `id`, and the run that took it. */
export function inputFate(
  binding: NativeEngineHandle,
  id: ThreadId,
  commandId: CommandId,
): InputFate {
  return JSON.parse(member(binding, "inputFate")(id, commandId) as string) as InputFate;
}
