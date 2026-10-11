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
it("control expires without another command and renewed input postpones its deadline", () => {
  const runtime = clock();
  const lease = new ControllerLease(runtime.now);
  lease.claim(human);
  const released: number[] = [];
  const stop = watchDeviceLease(lease, runtime, () => released.push(runtime.now()));
  runtime.advance(20000);
  lease.assert(human);
  runtime.advance(10000);
  expect(released).toEqual([]);
  expect(lease.current()).toEqual(human);
  runtime.advance(20000);
  expect(released).toEqual([50000]);
  expect(lease.status().controller).toBe("none");
  runtime.advance(30000);
  expect(released).toEqual([50000]);
  stop();
});
it("disconnecting or stopping cancels expiry cleanup before a subsequent owner takes control", () => {
  const runtime = clock();
  const lease = new ControllerLease(runtime.now);
  lease.claim(human);
  const released: number[] = [];
  watchDeviceLease(lease, runtime, () => released.push(runtime.now()))();
  lease.claim({ kind: "human", owner: "next" });
  runtime.advance(30000);
  expect(released).toEqual([]);
});
it("active input publishes its renewed deadline in a bounded update before displayed control expires", () => {
  const runtime = clock();
  const lease = new ControllerLease(runtime.now);
  lease.claim(human);
  const displayed: number[] = [];
  const stop = watchDeviceLease(
    lease,
    runtime,
    () => {},
    () => {
      const deadline = lease.status().leaseExpiresAt;
      if (deadline !== undefined) displayed.push(deadline);
    },
  );
  runtime.advance(1000);
  lease.assert(human);
  runtime.advance(1000);
  lease.assert(human);
  expect(displayed).toEqual([]);
  runtime.advance(3000);
  expect(displayed).toEqual([32000]);
  runtime.advance(5000);
  expect(displayed).toEqual([32000]);
  stop();
});
