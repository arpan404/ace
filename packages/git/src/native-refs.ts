// SPDX-License-Identifier: Apache-2.0

/**
 * The native refs shell (G1 owns the port): ref, branch and worktree-list
 * reads on `gix`, inside today's TypeScript service. G0 stub: every call
 * probes the addon and defers to the same TypeScript it replaces.
 */
import type { GitPart } from "@ace/provider-kit/native-switches";
import { runNativeOp, runNativeOpSync } from "./native-common.ts";

const part = "refs" satisfies GitPart;

/** Dispatches one refs operation to the native core when the part is on. */
export function runNativeRefs<T>(op: string, typescript: () => Promise<T>): Promise<T> {
  return runNativeOp(part, op, typescript);
}

/** The synchronous `runNativeRefs`, for the calls that stay synchronous. */
export function runNativeRefsSync<T>(op: string, typescript: () => T): T {
  return runNativeOpSync(part, op, typescript);
}
