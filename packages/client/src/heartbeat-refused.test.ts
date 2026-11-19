import { expect, test } from "vitest";
import { Heartbeat } from "./heartbeat.ts";

/** A heartbeat on manual time over a socket that refuses every ping (it owes too many pongs). */
function refusing() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  let missed = 0;
  const heartbeat = new Heartbeat(
    {
      set(delay, run) {
        const timer = { at: now + delay, run };
        timers.add(timer);
        return () => void timers.delete(timer);
      },
    },
    15_000,
    () => now,
  );
  heartbeat.start({ ping: () => false, missed: () => void missed++ });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      now = next.at;
      next.run();
    }
    now = until;
  };
  return { heartbeat, advance, missed: () => missed, timers: () => timers.size };
}

test("a wake whose ping can't go out still gets a deadline, and the socket is dropped at it", () => {
  const h = refusing();
  h.heartbeat.probe(5_000);
  // Nothing is left without a timer: the wake's deadline stands in for the beat.
  expect(h.timers()).toBeGreaterThan(0);
  h.advance(5_000);
  expect(h.missed()).toBe(1);
});
