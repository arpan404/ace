import { expect, it } from "vitest";
import { ControllerLease, watchDeviceLease } from "./index.ts";
function clock() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  return {
    now: () => now,
    after(ms: number, run: () => void) {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers)
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
    },
  };
}
const human = { kind: "human", owner: "viewer" } as const;
it("control expires without another command and renewed input postpones pointer cleanup", () => {
  const runtime = clock();
  const lease = new ControllerLease(runtime.now);
  lease.claim(human);
  const released: string[] = [];
  const stop = watchDeviceLease(lease, runtime, () => released.push("pointer released"));
  runtime.advance(20000);
  lease.assert(human);
  runtime.advance(10000);
  expect(released).toEqual([]);
  expect(lease.current()).toEqual(human);
  runtime.advance(20000);
  expect(released).toEqual(["pointer released"]);
  expect(lease.status().controller).toBe("none");
  runtime.advance(30000);
  expect(released).toEqual(["pointer released"]);
  stop();
});
it("disconnecting or stopping cancels expiry cleanup before a subsequent owner takes control", () => {
  const runtime = clock();
  const lease = new ControllerLease(runtime.now);
  lease.claim(human);
  const released: string[] = [];
  watchDeviceLease(lease, runtime, () => released.push("old pointer"))();
  lease.claim({ kind: "human", owner: "next" });
  runtime.advance(30000);
  expect(released).toEqual([]);
});
