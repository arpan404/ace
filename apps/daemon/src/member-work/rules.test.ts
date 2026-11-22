import { expect, it } from "vitest";
import { leaseClock, mayRun, offlineAllowanceMs, type Reachability } from "./rules.ts";

const minute = 60_000;
const held = (members: [string, string][], at = 0, receivedAt = 0) => ({
  org: "org_01ACME",
  epoch: 1,
  version: 1,
  digest: "0".repeat(64),
  at,
  receivedAt,
  members: new Map(members.map(([account, status]) => [account, { status, role: "member" }])),
});

it("the offline allowance is sixty minutes unless narrowed, and never above a day", () => {
  expect(offlineAllowanceMs(undefined)).toBe(60 * minute);
  expect(offlineAllowanceMs(5)).toBe(5 * minute);
  expect(offlineAllowanceMs(10_000)).toBe(1440 * minute);
  expect(offlineAllowanceMs(-3)).toBe(0);
  // The host's own ceiling narrows the policy's, never widens it.
  expect(offlineAllowanceMs(30, 10)).toBe(10 * minute);
  expect(offlineAllowanceMs(30, 120)).toBe(30 * minute);
});

it("a roster dated in the host's future buys its members no time", () => {
  const roster = held([["user_mia", "active"]], 50 * minute, 0);
  const run = (now: number) =>
    mayRun({
      account: "user_mia",
      roster,
      revoked: false,
      now,
      offlineMs: 0,
      reachability: "ok",
    });
  expect(run(2 * minute)).toBe(true);
  expect(run(2 * minute + 1)).toBe(false);
});

it("the offline allowance applies only while the backend can't be reached at all", () => {
  const roster = held([["user_mia", "active"]]);
  const run = (reachability: Reachability) =>
    mayRun({
      account: "user_mia",
      roster,
      revoked: false,
      now: 30 * minute,
      offlineMs: 60 * minute,
      reachability,
    });
  expect(run("unreachable")).toBe(true);
  for (const answered of ["ok", "refused", "unknown"] as const) expect(run(answered)).toBe(false);
});

it("only a roster two minutes old renews by itself, and only for an active member", () => {
  const roster = held([
    ["user_mia", "active"],
    ["user_ben", "inactive"],
  ]);
  const run = (account: string, now: number, revoked = false) =>
    mayRun({ account, roster, revoked, now, offlineMs: 0, reachability: "unreachable" });
  expect(run("user_mia", 2 * minute)).toBe(true);
  expect(run("user_mia", 2 * minute + 1)).toBe(false);
  expect(run("user_ben", 0)).toBe(false);
  expect(run("user_zoe", 0)).toBe(false);
  expect(run("user_mia", 0, true)).toBe(false);
});

it("the lease clock never goes back and never runs slower than the monotonic clock", () => {
  const clocks = { wall: 1_000 * minute, mono: 0 };
  const clock = leaseClock({
    wall: () => clocks.wall,
    monotonic: () => clocks.mono,
    highWater: undefined,
  });
  expect(clock.now()).toBe(1_000 * minute);
  clocks.wall -= 60 * minute;
  clocks.mono += minute;
  expect(clock.now()).toBe(1_001 * minute);
  // Suspended: the monotonic clock stood still, the wall clock didn't.
  clocks.wall = 1_100 * minute;
  expect(clock.now()).toBe(1_100 * minute);
  // A restart behind the last recorded time starts there, untrusted.
  const restarted = leaseClock({
    wall: () => 900 * minute,
    monotonic: () => 0,
    highWater: 1_100 * minute,
  });
  expect([restarted.trusted, restarted.now()]).toEqual([false, 1_100 * minute]);
});
