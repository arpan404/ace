// SPDX-License-Identifier: Apache-2.0
/**
 * T1b.5's per-case evidence setup file. With `ACE_TRANSPORT_EVIDENCE` set, it brackets every test
 * with two lines in that file: `{ "event": "case", "name", "pid" }` before the test, then
 * `{ "event": "case-end" }` after it, flushing what this process's native listeners handled in
 * between. A file's tests run in order in one worker, so the lines inside a case's markers are that
 * case's — its own process's and any daemon child's, which inherits the same file
 * (`daemon-launch-test-support.ts` passes the environment through).
 *
 * It is registered as a setup file for the unit and process projects (`vitest.config.ts`), so the
 * proof script's legs need no flag for it; with the variable unset (the off leg, every ordinary
 * run) it does nothing.
 */
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";
import { flushTransportEvidence } from "@ace/provider-kit/native-transport";

/** The evidence file this process writes, or undefined when it writes none. */
function evidencePath(): string | undefined {
  const path = process.env.ACE_TRANSPORT_EVIDENCE;
  return path === undefined || path === "" ? undefined : path;
}

/** One line, with the same tolerance the shell has: a failed write is never fatal. */
function append(path: string, line: object): void {
  try {
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  } catch {
    // The proof script reports a missing window as NONE; a test must not fail on it.
  }
}

/**
 * Registers the two hooks. Called once at import; the variable is read per case, so one process's
 * `ACE_TRANSPORT_EVIDENCE` change (as a test may make) is honoured.
 */
export function registerTransportCaseEvidence(): void {
  beforeEach((context) => {
    const path = evidencePath();
    if (path === undefined) return;
    // The task's own name, untruncated; `currentTestName` shortens a long title for display.
    append(path, { event: "case", name: context.task.name, pid: process.pid });
  });
  afterEach(() => {
    const path = evidencePath();
    if (path === undefined) return;
    // What this process's live listeners handled, before a later cleanup closes them: the case's
    // traffic lands in the case, not only in a fixture's close line.
    flushTransportEvidence();
    append(path, { event: "case-end", pid: process.pid });
  });
}

registerTransportCaseEvidence();
