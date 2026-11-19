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

/** Timers on the test's own clock: `fire` runs the ones due by then. */
function timers() {
  const due: { at: number; run: () => void }[] = [];
  return {
    after(now: () => number) {
      return (ms: number, run: () => void) => {
        const timer = { at: now() + ms, run };
        due.push(timer);
        return () => {
          const index = due.indexOf(timer);
          if (index >= 0) due.splice(index, 1);
        };
      };
    },
    fire(at: number) {
      for (const timer of due.filter((entry) => entry.at <= at)) {
        due.splice(due.indexOf(timer), 1);
        timer.run();
      }
    },
    pending: () => due.length,
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
    after: timers().after(() => now),
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
    void f.schedule.reader("session-1", 3_000);
    await settle();
    expect(f.reads()).toBe(2);
    void f.schedule.reader("session-1", 3_000);
    await f.advance(interval);
    expect(f.reads()).toBe(3);
    f.schedule.readerGone("session-1");
    await f.advance(interval);
    expect(f.reads()).toBe(3);
  });

  it("does not re-read for a new client while the last reading is fresh", async () => {
    const f = setup();
    await readNow(f);
    void f.schedule.reader("session-1", 3_000);
    await settle();
    expect(f.reads()).toBe(1);
  });

  it("joins a reading under way instead of starting another", async () => {
    const gate = Promise.withResolvers<void>();
    let reads = 0;
    const schedule = new LimitsSchedule({
      intervalMs: interval,
      now: () => 0,
      read: () => {
        reads++;
        return gate.promise;
      },
      busy: () => true,
      quotas: () => [],
      after: () => () => {},
    });
    const first = schedule.refresh();
    schedule.tick();
    const second = schedule.refresh();
    gate.resolve();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
  });

  it("starts no reading after it stops", async () => {
    const f = setup({ busy: true });
    await f.schedule.stop();
    await f.advance(interval);
    void f.schedule.reader("session-1", 3_000);
    expect(f.reads()).toBe(0);
  });
});

/** A schedule whose reads hang until released, on a manual clock and timers. */
function hung() {
  let now = 0;
  let reads = 0;
  const gates: (() => void)[] = [];
  const clock = timers();
  const schedule = new LimitsSchedule({
    intervalMs: interval,
    now: () => now,
    read: () => {
      reads++;
      return new Promise<void>((resolve) => gates.push(resolve));
    },
    busy: () => false,
    quotas: () => [],
    after: clock.after(() => now),
  });
  return {
    schedule,
    reads: () => reads,
    release: () => gates.splice(0).forEach((open) => open()),
    advance(ms: number) {
      now += ms;
      clock.fire(now);
    },
    pending: clock.pending,
  };
}

it("a hung limits read holds whoever wants fresh readings no longer than the cap", async () => {
  const f = hung();
  let settled = false;
  const waiting = f.schedule.fresh(3_000).then(() => (settled = true));
  await settle();
  expect(f.reads()).toBe(1);
  f.advance(2_999);
  await settle();
  expect(settled).toBe(false);
  f.advance(1);
  await waiting;
  expect(settled).toBe(true);
  // The read goes on in the background, and the next ask joins it instead of starting another.
  const again = f.schedule.fresh(3_000);
  f.release();
  await again;
  expect(f.reads()).toBe(1);
  expect(f.pending()).toBe(0);
});

it("asking for fresh readings ends at once when the asker cancels", async () => {
  const f = hung();
  const controller = new AbortController();
  const waiting = f.schedule.fresh(3_000, controller.signal);
  controller.abort();
  await waiting;
  expect(f.pending()).toBe(0);
  f.release();
});

it("readings read within the interval are used as they are, with no read", async () => {
  const f = hung();
  const first = f.schedule.fresh(3_000);
  f.release();
  await first;
  f.advance(interval - 1);
  await f.schedule.fresh(3_000);
  expect(f.reads()).toBe(1);
  f.advance(1);
  const stale = f.schedule.fresh(3_000);
  f.release();
  await stale;
  expect(f.reads()).toBe(2);
});

it("a client's first account read waits for readings from before the interval", async () => {
  const f = hung();
  const first = f.schedule.fresh(3_000);
  f.release();
  await first;
  f.advance(interval * 3);
  let answered = false;
  const reading = f.schedule.reader("session-1", 3_000).then(() => (answered = true));
  await settle();
  expect(answered).toBe(false);
  f.release();
  await reading;
  expect(f.reads()).toBe(2);
  // Its later reads don't wait.
  await f.schedule.reader("session-1", 3_000);
  expect(f.reads()).toBe(2);
});

it("an explicit refresh during a reading reads again after it, once for every ask meanwhile", async () => {
  const f = hung();
  const startup = f.schedule.refresh();
  const asked = [f.schedule.refreshAfter(), f.schedule.refreshAfter()];
  expect(f.reads()).toBe(1);
  f.release();
  await startup;
  await settle();
  expect(f.reads()).toBe(2);
  f.release();
  await Promise.all(asked);
  expect(f.reads()).toBe(2);
});
