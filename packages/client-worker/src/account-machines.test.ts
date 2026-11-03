import { expect, it } from "vitest";
import { accountMachineState } from "./account-machines.ts";

const idle = { asking: undefined, lockedUntil: undefined };

it("an account machine waiting for its code reads as asking, with the lock's end when locked", () => {
  expect(
    accountMachineState(
      { status: "machine_code" },
      { asking: "machine_code_locked", lockedUntil: 9000 },
    ),
  ).toEqual({ kind: "asking", reason: "machine_code_locked", lockedUntil: 9000 });
  expect(
    accountMachineState(
      { status: "machine_code" },
      { asking: "machine_code_wrong", lockedUntil: undefined },
    ),
  ).toEqual({ kind: "asking", reason: "machine_code_wrong" });
});

it("an account machine that retries by itself reads as connecting until it is online", () => {
  expect(accountMachineState({ status: "offline" }, idle)).toEqual({ kind: "connecting" });
  expect(accountMachineState({ status: "connecting" }, idle)).toEqual({ kind: "connecting" });
  // A code the person already entered is on its way: no prompt while it is checked.
  expect(accountMachineState({ status: "machine_code" }, idle)).toEqual({ kind: "connecting" });
  expect(accountMachineState({ status: "online" }, idle)).toEqual({ kind: "open" });
});

it("a refused or closed account machine reads as failed with why", () => {
  expect(
    accountMachineState(
      { status: "auth_failed", error: { message: "Sign in to ace again." } },
      idle,
    ),
  ).toEqual({ kind: "failed", message: "Sign in to ace again." });
  expect(accountMachineState(undefined, idle)).toMatchObject({ kind: "failed" });
});
