import { expect, test } from "vitest";
import { startMainBeat } from "../diagnostics/main-beat.ts";
import { watchHealth } from "./watchdog.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A watch on wall-clock time the test moves by hand, with one probe answer it decides, and the
 * app's main beat on the same clock. A sleep moves the clock without running any timer: on a
 * Mac nothing in the app runs while it sleeps.
 */
function watched() {
  let now = 0;
  const timers = new Set<{ at: number; run: () => void }>();
  let answer: ((healthy: boolean) => void) | undefined;
  const logs: string[] = [];
  let unresponsive = 0;
  const set = (delayMs: number, run: () => void) => {
    const timer = { at: now + delayMs, run };
    timers.add(timer);
    return () => void timers.delete(timer);
  };
  const beat = startMainBeat({
    now: () => now,
    clock: {
      every(ms, tick) {
        let cancel = set(ms, function again() {
          tick();
          cancel = set(ms, again);
        });
        return () => cancel();
      },
    },
  });
  watchHealth({
    intervalMs: 5_000,
    timeoutMs: 10_000,
    failures: 1,
    probe: () => new Promise((resolve) => (answer = resolve)),
    timers: { set },
    now: () => now,
    freezes: beat,
    log: (_level, message) => logs.push(message),
    onUnresponsive: () => unresponsive++,
  });
  return {
    beat,
    logs,
    unresponsive: () => unresponsive,
    probing: () => answer !== undefined,
    async answer(healthy: boolean) {
      const reply = answer;
      answer = undefined;
      reply?.(healthy);
      await settle();
    },
    /** Time passes with the app running: every timer due fires, in order. */
    async run(ms: number) {
      const until = now + ms;
      for (;;) {
        await settle();
        const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.delete(next);
        now = next.at;
        next.run();
      }
      now = until;
      await settle();
    },
    sleep(ms: number) {
      now += ms;
    },
  };
}

test("a health check that fails across a sleep is not counted as missed", async () => {
  const watch = watched();
  await watch.run(5_000);
  expect(watch.probing()).toBe(true);
  // The Mac sleeps with the check out; on waking its request fails before any timer runs.
  watch.sleep(3_600_000);
  watch.beat.resumed();
  await watch.answer(false);
  expect(watch.unresponsive()).toBe(0);
  expect(watch.logs).toContain("The computer slept during a daemon health check; checking again");
  // It is asked again at once, and a daemon that is up answers.
  await watch.run(0);
  expect(watch.probing()).toBe(true);
  await watch.answer(true);
  expect(watch.unresponsive()).toBe(0);
  expect(watch.logs).not.toContain("The daemon missed a health check");
});

test("a check that fails on waking is not counted even before the OS says it resumed", async () => {
  const watch = watched();
  await watch.run(5_000);
  watch.sleep(3_600_000);
  await watch.answer(false);
  expect(watch.unresponsive()).toBe(0);
  await watch.run(0);
  expect(watch.probing()).toBe(true);
});

test("a daemon that fails its check while the app runs on time is still counted", async () => {
  const watch = watched();
  await watch.run(5_000);
  await watch.run(1_000);
  await watch.answer(false);
  expect(watch.unresponsive()).toBe(1);
});
