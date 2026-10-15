import { expect, test } from "vitest";
import { createLoopMonitor, type LoopStall } from "./loop-monitor.ts";

function manualClock() {
  let time = 0;
  let tick: (() => void) | undefined;
  return {
    clock: {
      now: () => time,
      every(_milliseconds: number, run: () => void) {
        tick = run;
        return () => {
          tick = undefined;
        };
      },
    },
    /** The timer fires `late` milliseconds after it was due. */
    fire(late: number) {
      time += 500 + late;
      tick?.();
    },
  };
}

test("a loop that runs on time reports no delay and logs nothing", () => {
  const time = manualClock();
  const stalls: LoopStall[] = [];
  const monitor = createLoopMonitor({ clock: time.clock, onStall: (stall) => stalls.push(stall) });
  time.fire(3);
  time.fire(0);
  expect(monitor.status()).toEqual({ delayMs: 0, maxDelayMs: 3, stalls: 0 });
  expect(stalls).toEqual([]);
});

test("a stall over a second is logged at once, repeats within a minute are counted but not logged", () => {
  const time = manualClock();
  const stalls: LoopStall[] = [];
  const monitor = createLoopMonitor({ clock: time.clock, onStall: (stall) => stalls.push(stall) });
  time.fire(1_200);
  time.fire(2_500);
  time.fire(1_100);
  time.fire(10);
  expect(stalls).toEqual([{ delayMs: 1_200, suppressed: 0 }]);
  // A watchdog reading status tells the busy loop's history from its current, recovered state.
  expect(monitor.status()).toEqual({ delayMs: 10, maxDelayMs: 2_500, stalls: 3 });
  for (let n = 0; n < 120; n++) time.fire(0);
  time.fire(1_500);
  expect(stalls.at(-1)).toEqual({ delayMs: 1_500, suppressed: 2 });
});
