// SPDX-License-Identifier: Apache-2.0

/**
 * The native writes shell (G4 owns the port): commits, stage, merges, stack
 * replays, branches, worktrees, fetches, pushes, clones, transfers and
 * publications on the core, each running the person's hooks and signing in
 * their roots exactly where TypeScript does. G0 stub: every call probes the
 * addon and defers to the same TypeScript it replaces.
 *
 * Transfer dispatch by module ownership: transfer reads (`sourceCheckout`,
 * `transferOrigin`, `checkoutFacts`, `ignoredPaths`, `bundleRefs`,
 * `hasCommit`, `verifyBundle`) go through `native-reads`; `captureChanges`
 * through `native-checkpoints`; the rest through this shell. G3d, G4c and
 * G5 refine the bodies, never the mapping.
 */
import type { GitPart } from "@ace/provider-kit/native-switches";
import { runNativeOp, runNativeOpSync } from "./native-common.ts";

const part = "writes" satisfies GitPart;

/** Dispatches one writes operation to the native core when the part is on. */
export function runNativeWrites<T>(op: string, typescript: () => Promise<T>): Promise<T> {
  return runNativeOp(part, op, typescript);
}

/** The synchronous `runNativeWrites`, for the calls that stay synchronous. */
export function runNativeWritesSync<T>(op: string, typescript: () => T): T {
  return runNativeOpSync(part, op, typescript);
}
