// SPDX-License-Identifier: Apache-2.0

/**
 * The native reads shell (G3 owns the port): status, info, summaries, diffs,
 * history, revision lines, conflicts, publication scans and transfer reads on
 * the core. G0 stub: every call probes the addon and defers to the same
 * TypeScript it replaces.
 */
import type { GitPart } from "@ace/provider-kit/native-switches";
import { runNativeOp, runNativeOpSync } from "./native-common.ts";

const part = "reads" satisfies GitPart;

/** Dispatches one reads operation to the native core when the part is on. */
export function runNativeReads<T>(op: string, typescript: () => Promise<T>): Promise<T> {
  return runNativeOp(part, op, typescript);
}

/** The synchronous `runNativeReads`, for the calls that stay synchronous. */
export function runNativeReadsSync<T>(op: string, typescript: () => T): T {
  return runNativeOpSync(part, op, typescript);
}
