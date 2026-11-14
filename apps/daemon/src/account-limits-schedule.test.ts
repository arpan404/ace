import { describe, expect, it } from "vitest";
import type { AccountQuota } from "@ace/protocol/accounts";
import { LimitsSchedule } from "./account-limits-schedule.ts";

const minute = 60_000;
const interval = 5 * minute;

function quota(resetsAt: number | null, limitError = false): AccountQuota {
  const window = { usedPercent: 100, resetsAt };
  return {
    auth: "logged_in",
    observedAt: 0,
    windows: limitError ? {} : { session: window },
    blockers: limitError ? { limitError: window } : {},
    usage: {},
  };
}

function setup(options: { busy?: boolean; quotas?: AccountQuota[] } = {}) {
  let now = 0;
  let reads = 0;
  const state = { busy: options.busy ?? false, quotas: options.quotas ?? [] };
  const schedule = new LimitsSchedule({
    intervalMs: interval,
    now: () => now,
    read: async () => {
      reads++;
    },
    busy: () => state.busy,
    quotas: () => state.quotas,
  });
  return {
    schedule,
    state,
    reads: () => reads,
    async advance(ms: number) {
      now += ms;
      schedule.tick();
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function readNow(f: ReturnType<typeof setup>) {
  await f.schedule.refresh();
}

describe("account limits schedule", () => {
  it("runs no limit reads while nothing waits on a limit and no client reads accounts", async () => {
    const f = setup({ quotas: [quota(null)] });
    await readNow(f);
    for (let tick = 0; tick < 24; tick++) await f.advance(interval);
    expect(f.reads()).toBe(1);
  });

  it("keeps reading on every tick while a thread waits on a limit, so it is released", async () => {
    const f = setup({ busy: true });
    await readNow(f);
    for (let tick = 0; tick < 3; tick++) await f.advance(interval);
    expect(f.reads()).toBe(4);
    f.state.busy = false;
    await f.advance(interval);
    expect(f.reads()).toBe(4);
  });

  it("reads once a stored window's reset passes, then waits again", async () => {
    const f = setup({ quotas: [quota(12 * minute)] });
    await readNow(f);
    await f.advance(interval);
    await f.advance(interval);
    expect(f.reads()).toBe(1);
    await f.advance(interval);
    expect(f.reads()).toBe(2);
    await f.advance(interval);
    expect(f.reads()).toBe(2);
  });

  it("reads when a usage-limit error's reset passes", async () => {
    const f = setup({ quotas: [quota(4 * minute, true)] });
    await readNow(f);
    await f.advance(interval);
    expect(f.reads()).toBe(2);
  });

  it("refreshes stale readings when a client first reads accounts and keeps them fresh until it leaves", async () => {
    const f = setup();
    await readNow(f);
    await f.advance(interval * 4);
    expect(f.reads()).toBe(1);
    f.schedule.reader("session-1");
    await settle();
    expect(f.reads()).toBe(2);
    f.schedule.reader("session-1");
    await f.advance(interval);
    expect(f.reads()).toBe(3);
    f.schedule.readerGone("session-1");
    await f.advance(interval);
    expect(f.reads()).toBe(3);
  });

  it("does not re-read for a new client while the last reading is fresh", async () => {
    const f = setup();
    await readNow(f);
    f.schedule.reader("session-1");
    await settle();
    expect(f.reads()).toBe(1);
  });

  it("joins a reading under way instead of starting another", async () => {
    let release = () => {};
    let reads = 0;
    const schedule = new LimitsSchedule({
      intervalMs: interval,
      now: () => 0,
      read: () => {
        reads++;
        return new Promise<void>((resolve) => (release = resolve));
      },
      busy: () => true,
      quotas: () => [],
    });
    const first = schedule.refresh();
    schedule.tick();
    const second = schedule.refresh();
    release();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
  });

  it("starts no reading after it stops", async () => {
    const f = setup({ busy: true });
    await f.schedule.stop();
    await f.advance(interval);
    f.schedule.reader("session-1");
    expect(f.reads()).toBe(0);
  });
});
