import { expect, test } from "vitest";
import { hostBusyWatch } from "./host-busy.ts";

function idle(): boolean | undefined {
  return false;
}

function world() {
  const timers: { ms: number; run: () => void; cancelled: boolean }[] = [];
  const applied: boolean[] = [];
  const reported: unknown[] = [];
  let reading = idle;
  const watch = hostBusyWatch({
    busy: () => reading(),
    apply: (busy) => applied.push(busy),
    report: (error) => reported.push(error),
    after: (ms, run) => {
      const timer = { ms, run, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    settleMs: 100,
    retryMs: { first: 1000, most: 4000 },
  });
  /** Fires the one live timer, as the clock would. */
  const fire = () => {
    const live = timers.filter((timer) => !timer.cancelled);
    expect(live).toHaveLength(1);
    const [timer] = live;
    if (!timer) throw new Error("no timer armed");
    timer.cancelled = true;
    timer.run();
    return timer.ms;
  };
  return {
    watch,
    timers,
    applied,
    reported,
    fire,
    read: (next: typeof reading) => (reading = next),
  };
}

test("an unreadable tree reads busy, even after an idle read, until a read succeeds", () => {
  const { watch, applied, reported, fire, read } = world();
  watch.written();
  expect(fire()).toBe(100);
  expect(applied).toEqual([false]);

  // A child may have started since: the store fails, nothing escapes the timer, and the tree
  // reads busy through every retry rather than staying idle.
  read(() => {
    throw new Error("database is locked");
  });
  watch.written();
  expect(() => fire()).not.toThrow();
  expect(fire()).toBe(1000);
  expect(fire()).toBe(2000);
  expect(applied).toEqual([false, true, true, true]);
  expect(reported).toHaveLength(3);

  // Writes during the retry wait share it; once readable, the real flag applies.
  watch.written();
  read(() => false);
  expect(fire()).toBe(4000);
  expect(applied.at(-1)).toBe(false);
});

test("a read asked for now that fails reads busy and is retried instead of throwing", () => {
  const { watch, applied, reported, fire, read } = world();
  read(() => {
    throw new Error("disk I/O error");
  });
  expect(() => watch.now()).not.toThrow();
  expect(reported).toHaveLength(1);
  expect(applied).toEqual([true]);
  read(() => false);
  expect(fire()).toBe(1000);
  expect(applied).toEqual([true, false]);
});
