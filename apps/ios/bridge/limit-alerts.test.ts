import type { AccountQuota } from "@ace/protocol/accounts";
import { accountView, type AccountView } from "@ace/ui-core";
import { expect, test } from "vitest";
import { LimitWatch, type LimitAlert } from "./limit-alerts.ts";

/* Usage-limit alerts on the phone: an account read every minute, each change said once. */

const hour = 3_600_000;
const start = new Date("2026-11-11T15:00:00").getTime();

function account(used: number, at: number, resetsIn = 2 * hour): AccountView {
  const quota: AccountQuota = {
    auth: "logged_in",
    observedAt: at,
    windows: { five_hour: { usedPercent: used, resetsAt: at + resetsIn } },
    blockers: {},
    usage: {},
  };
  return accountView({
    id: "claude-work",
    provider: "claude",
    label: "work",
    quota,
    availability: used >= 100 ? "exhausted" : used >= 80 ? "near_limit" : "available",
  });
}

function watch(readings: ((at: number) => AccountView[])[]) {
  let now = start;
  const timers: { at: number; run: () => void }[] = [];
  const said: LimitAlert[] = [];
  let read = 0;
  const limits = new LimitWatch(
    async () => (readings[Math.min(read++, readings.length - 1)] ?? (() => []))(now),
    (delay, run) => {
      const timer = { at: now + delay, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    () => now,
    (alert) => said.push(alert),
  );
  /** Moves the clock to the next timer and runs it. */
  const next = async () => {
    const timer = timers.sort((a, b) => a.at - b.at).shift();
    if (!timer) return;
    now = timer.at;
    timer.run();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { limits, said, next, timers };
}

test("an account crossing near and then its limit is said once each, read again every minute", async () => {
  const phone = watch([
    (at) => [account(40, at)],
    (at) => [account(85, at)],
    (at) => [account(85, at)],
    (at) => [account(100, at)],
  ]);
  phone.limits.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(phone.said).toEqual([]);
  await phone.next();
  await phone.next();
  await phone.next();
  expect(phone.said.map((alert) => alert.title)).toEqual([
    "Claude Code · work is near its usage limit",
    "Claude Code · work reached its usage limit",
  ]);
  expect(phone.said[0]?.body).toContain("85% of the");
});

test("stopping ends the reads: nothing more is scheduled or said", async () => {
  const phone = watch([(at) => [account(40, at)], (at) => [account(100, at)]]);
  phone.limits.start();
  await Promise.resolve();
  await Promise.resolve();
  phone.limits.stop();
  expect(phone.timers).toEqual([]);
  expect(phone.said).toEqual([]);
});

test("a read still out when the watch stops and starts again is dropped: one timer, not two", async () => {
  let release: (views: AccountView[]) => void = () => {};
  const timers: (() => void)[] = [];
  const said: LimitAlert[] = [];
  let reads = 0;
  const limits = new LimitWatch(
    () => {
      reads++;
      return reads === 1
        ? new Promise<AccountView[]>((resolve) => (release = resolve))
        : Promise.resolve([account(40, start)]);
    },
    (_delay, run) => {
      timers.push(run);
      return () => timers.splice(timers.indexOf(run), 1);
    },
    () => start,
    (alert) => said.push(alert),
  );
  limits.start();
  limits.stop();
  limits.start();
  await Promise.resolve();
  await Promise.resolve();
  // The first run's read lands late: it neither alerts nor schedules alongside the second.
  release([account(100, start)]);
  await Promise.resolve();
  await Promise.resolve();
  expect(timers).toHaveLength(1);
  limits.stop();
  expect(timers).toHaveLength(0);
});
