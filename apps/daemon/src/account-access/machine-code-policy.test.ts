import { expect, it } from "vitest";
import {
  CODE_ATTEMPTS,
  CODE_LOCK_MS,
  afterAttempt,
  codeStep,
  type CodeLock,
} from "./machine-code-policy.ts";

const open: CodeLock = { failures: 0, lockedUntil: null };
const step = (input: Partial<Parameters<typeof codeStep>[0]>) =>
  codeStep({ required: true, passed: false, offered: undefined, lock: open, now: 0, ...input });

it("a machine without a code, or a device that passed the current code, is admitted", () => {
  expect(step({ required: false })).toEqual({ kind: "admit" });
  expect(step({ passed: true })).toEqual({ kind: "admit" });
});

it("a device that has not passed the code is asked for it, and an offered code is checked", () => {
  expect(step({})).toEqual({ kind: "refuse", reason: "machine_code_required" });
  expect(step({ offered: "2468" })).toEqual({ kind: "check", code: "2468" });
});

it("five wrong codes pause code entry on the machine for fifteen minutes", () => {
  let lock = open;
  const reasons: string[] = [];
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const next = afterAttempt(lock, false, 1_000);
    lock = next.lock;
    reasons.push(next.step.kind === "refuse" ? next.step.reason : "admit");
  }
  expect(reasons).toEqual([
    ...Array.from({ length: CODE_ATTEMPTS - 1 }, () => "machine_code_wrong"),
    "machine_code_locked",
  ]);
  // Even the right code waits out the lock.
  expect(step({ offered: "2468", lock, now: 1_000 + CODE_LOCK_MS - 1 })).toEqual({
    kind: "refuse",
    reason: "machine_code_locked",
  });
  expect(step({ offered: "2468", lock, now: 1_000 + CODE_LOCK_MS })).toEqual({
    kind: "check",
    code: "2468",
  });
  // After the lock, a wrong code starts a fresh count.
  expect(afterAttempt(lock, false, 1_000 + CODE_LOCK_MS).lock).toEqual({
    failures: 1,
    lockedUntil: null,
  });
});

it("a right code clears earlier wrong attempts", () => {
  const twice = afterAttempt(afterAttempt(open, false, 0).lock, false, 0).lock;
  expect(afterAttempt(twice, true, 0)).toEqual({ lock: open, step: { kind: "admit" } });
});
