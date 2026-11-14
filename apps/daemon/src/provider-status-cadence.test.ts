import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ProviderStatuses } from "./provider-status.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Statuses on a PATH with no CLIs, a clock the test moves and timers it fires. */
async function statuses() {
  const home = await mkdtemp(join(tmpdir(), "ace-provider-cadence-"));
  const clock = { now: 1_000 };
  const timers = new Map<() => void, number>();
  let checks = 0;
  const subject = new ProviderStatuses(
    {
      env: { HOME: home, PATH: "" },
      cursorSdk: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
      antigravity: async () => ({ installed: false, auth: "unknown", loginHint: "unused" }),
      checked: () => {
        checks++;
      },
    },
    {
      now: () => clock.now,
      schedule(callback, milliseconds) {
        timers.set(callback, milliseconds);
        return () => timers.delete(callback);
      },
    },
  );
  cleanups.push(async () => {
    await subject.close();
    await rm(home, { recursive: true, force: true });
  });
  await subject.firstCheck();
  const settle = async () => {
    // A check started by a listener or a read settles on its own; wait for it to publish.
    await expect.poll(() => subject.list().every((row) => !row.refreshing)).toBe(true);
  };
  return {
    subject,
    clock,
    timers,
    checks: () => checks,
    settle,
    fire() {
      const pending = [...timers.keys()];
      timers.clear();
      for (const callback of pending) callback();
    },
  };
}

test("no provider CLI is checked on a timer while no client listens", async () => {
  const { timers, checks } = await statuses();
  expect(checks()).toBe(1);
  expect([...timers.values()]).toEqual([]);
});

test("a listening client gets a check every five minutes until it leaves", async () => {
  const status = await statuses();
  status.clock.now += 60_000;
  const stop = status.subject.listen(() => {});
  // The first check is a minute old: the next one is due in the remaining four.
  expect([...status.timers.values()]).toEqual([240_000]);
  status.clock.now += 240_000;
  status.fire();
  await status.settle();
  expect(status.checks()).toBe(2);
  expect([...status.timers.values()]).toEqual([300_000]);
  stop();
  expect([...status.timers.values()]).toEqual([]);
});

test("a client attaching after a long gap gets a check at once", async () => {
  const status = await statuses();
  status.clock.now += 3_600_000;
  status.subject.listen(() => {});
  await status.settle();
  expect(status.checks()).toBe(2);
  expect(status.subject.list().every((row) => !row.stale)).toBe(true);
});

test("a stale read with nobody listening answers at once and checks again behind it", async () => {
  const status = await statuses();
  status.clock.now += 300_000;
  const rows = status.subject.list();
  expect(rows.every((row) => row.stale)).toBe(true);
  await status.settle();
  expect(status.checks()).toBe(2);
  expect(status.subject.list().every((row) => !row.stale)).toBe(true);
  expect([...status.timers.values()]).toEqual([]);
});
