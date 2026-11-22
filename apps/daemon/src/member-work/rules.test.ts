import { expect, it } from "vitest";
import { mayRun, offlineAllowanceMs } from "./rules.ts";

const minute = 60_000;

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
  const members = new Map([["user_mia", { status: "active", role: "member" }]]);
  const roster = { org: "org_01ACME", version: 1, at: 50 * minute, receivedAt: 0, members };
  const run = (now: number) =>
    mayRun({ account: "user_mia", roster, revoked: false, now, offlineMs: 0 });
  expect(run(2 * minute)).toBe(true);
  expect(run(2 * minute + 1)).toBe(false);
});

it("with no allowance, only a roster two minutes old renews, and only for an active member", () => {
  const members = new Map([
    ["user_mia", { status: "active", role: "member" }],
    ["user_ben", { status: "inactive", role: "member" }],
  ]);
  const roster = { org: "org_01ACME", version: 1, at: 0, receivedAt: 0, members };
  const run = (account: string, now: number, revoked = false) =>
    mayRun({ account, roster, revoked, now, offlineMs: 0 });
  expect(run("user_mia", 2 * minute)).toBe(true);
  expect(run("user_mia", 2 * minute + 1)).toBe(false);
  expect(run("user_ben", 0)).toBe(false);
  expect(run("user_zoe", 0)).toBe(false);
  expect(run("user_mia", 0, true)).toBe(false);
});
