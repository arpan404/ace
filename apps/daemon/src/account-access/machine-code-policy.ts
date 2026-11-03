import type { MachineCodeRefusal } from "@ace/protocol";

/** Wrong codes allowed before code entry pauses for the whole machine (ADR 0111). */
export const CODE_ATTEMPTS = 5;
export const CODE_LOCK_MS = 15 * 60_000;

/** Wrong attempts since the last right one, and when a lock ends (counted per machine). */
export type CodeLock = { failures: number; lockedUntil: number | null };

export type CodeStep =
  | { kind: "admit" }
  | { kind: "refuse"; reason: MachineCodeRefusal }
  /** Check the offered code, then call `afterAttempt` with the result. */
  | { kind: "check"; code: string };

/** What a grant-authenticated device must do about the machine code. Pure. */
export function codeStep(input: {
  /** A code is set on this machine. */
  required: boolean;
  /** This device (on this account) has passed the current code's version. */
  passed: boolean;
  offered: string | undefined;
  lock: CodeLock;
  now: number;
}): CodeStep {
  if (!input.required || input.passed) return { kind: "admit" };
  if (input.lock.lockedUntil !== null && input.lock.lockedUntil > input.now)
    return { kind: "refuse", reason: "machine_code_locked" };
  if (input.offered === undefined) return { kind: "refuse", reason: "machine_code_required" };
  return { kind: "check", code: input.offered };
}

/** The lock after one checked attempt, and what to tell the device. Pure. */
export function afterAttempt(
  lock: CodeLock,
  correct: boolean,
  now: number,
): { lock: CodeLock; step: Exclude<CodeStep, { kind: "check" }> } {
  if (correct) return { lock: { failures: 0, lockedUntil: null }, step: { kind: "admit" } };
  // A lock that has run out starts a fresh count.
  const failures = (lock.lockedUntil !== null && lock.lockedUntil <= now ? 0 : lock.failures) + 1;
  if (failures >= CODE_ATTEMPTS)
    return {
      lock: { failures: 0, lockedUntil: now + CODE_LOCK_MS },
      step: { kind: "refuse", reason: "machine_code_locked" },
    };
  return {
    lock: { failures, lockedUntil: null },
    step: { kind: "refuse", reason: "machine_code_wrong" },
  };
}
