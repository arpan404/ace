import { expect, test } from "vitest";
import { holdStoppable, remoteContactStep } from "./remote-contact.ts";

const machine = { machine: "rijan", name: "MacBook Pro Rijan" };

test("a remote child its machine stopped reporting says it lost contact and may resume", () => {
  expect(remoteContactStep({ machine: { ...machine, contact: "lost" } })).toBe(
    "lost contact · resumes if it reports",
  );
});

test("a remote child stopped without confirmation says so", () => {
  expect(remoteContactStep({ machine: { ...machine, contact: "unconfirmed" } })).toBe(
    "stopped · didn't confirm",
  );
});

test("a reachable remote child and a local one add no words", () => {
  expect(remoteContactStep({ machine })).toBeUndefined();
  expect(remoteContactStep({})).toBeUndefined();
});

const hold = (status: "running" | "unknown" | "stopped" | "completed") => ({
  status,
  stoppable: true,
});

test("the person can stop a hold while it runs or lost contact, never once it ended", () => {
  expect(
    ["running", "unknown", "stopped", "completed"].map((s) => holdStoppable(hold(s as never))),
  ).toEqual([true, true, false, false]);
  expect(holdStoppable({ status: "running", stoppable: false })).toBe(false);
});
