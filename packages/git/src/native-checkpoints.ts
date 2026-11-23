// SPDX-License-Identifier: Apache-2.0

/**
 * The native checkpoints shell (G5 owns the port; G6 adds `snapshot-hash`):
 * checkpoints, live diffs, `workspaceRevision`, `captureChanges` and restore,
 * ported step for step. G0 stub: every call probes the addon and defers to
 * the same TypeScript it replaces.
 */
import type { GitPart } from "@ace/provider-kit/native-switches";
import { runNativeOp, runNativeOpSync } from "./native-common.ts";

const part = "checkpoints" satisfies GitPart;

/** Dispatches one checkpoints operation to the native core when the part is on. */
export function runNativeCheckpoints<T>(op: string, typescript: () => Promise<T>): Promise<T> {
  return runNativeOp(part, op, typescript);
}

/** The synchronous `runNativeCheckpoints`, for the calls that stay synchronous. */
export function runNativeCheckpointsSync<T>(op: string, typescript: () => T): T {
  return runNativeOpSync(part, op, typescript);
}
