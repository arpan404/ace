import { expect, test } from "vitest";
import { frameThrottle } from "./frame-throttle.ts";

function frames() {
  const queued: (() => void)[] = [];
  return {
    frame(callback: () => void) {
      queued.push(callback);
      return () => {
        const at = queued.indexOf(callback);
        if (at >= 0) queued.splice(at, 1);
      };
    },
    flush() {
      for (const callback of queued.splice(0)) callback();
    },
  };
}

test("many requests within a frame run once in that frame", () => {
  const clock = frames();
  let runs = 0;
  const throttle = frameThrottle(() => runs++, clock.frame);
  throttle.request();
  throttle.request();
  throttle.request();
  expect(runs).toBe(0);
  clock.flush();
  expect(runs).toBe(1);
  throttle.request();
  clock.flush();
  expect(runs).toBe(2);
});

test("a cancelled request never runs", () => {
  const clock = frames();
  let runs = 0;
  const throttle = frameThrottle(() => runs++, clock.frame);
  throttle.request();
  throttle.cancel();
  clock.flush();
  expect(runs).toBe(0);
});
