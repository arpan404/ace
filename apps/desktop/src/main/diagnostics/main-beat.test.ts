import { expect, test } from "vitest";
import { startMainBeat } from "./main-beat.ts";

/** The main beat on a clock the test moves; `beat()` is the beat's timer firing. */
function beating() {
  let now = 0;
  let tick: (() => void) | undefined;
  const beat = startMainBeat({
    now: () => now,
    clock: {
      every(_ms, run) {
        tick = run;
        return () => (tick = undefined);
      },
    },
  });
  return {
    beat,
    pass(ms: number) {
      now += ms;
    },
    tick: () => tick?.(),
  };
}

test("a main thread that comes back late is reported as a freeze", () => {
  const main = beating();
  main.pass(500);
  main.tick();
  main.pass(6_000);
  main.tick();
  expect(main.beat.lastThaw()).toEqual({ at: 6_500, frozenMs: 5_500, slept: false });
});

test.each([
  [
    "before the beat comes back",
    (main: ReturnType<typeof beating>) => {
      main.beat.resumed();
      main.tick();
    },
  ],
  [
    "after the beat came back",
    (main: ReturnType<typeof beating>) => {
      main.tick();
      main.beat.resumed();
    },
  ],
])("a gap the OS says was sleep is reported as sleep, said %s", (_when, wake) => {
  const main = beating();
  main.pass(500);
  main.tick();
  main.pass(3_600_000);
  wake(main);
  expect(main.beat.lastThaw()).toMatchObject({ slept: true, frozenMs: 3_599_500 });
});
