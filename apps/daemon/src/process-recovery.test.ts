import { expect, test } from "vitest";
import { verifyRecovery, type RecoveryClock } from "./process-recovery.ts";

/** A clock that only moves when recovery waits. */
function manualClock(): RecoveryClock & { waited: number } {
  let now = 0;
  const clock = {
    waited: 0,
    now: () => now,
    async wait(ms: number) {
      now += ms;
      clock.waited += ms;
    },
  };
  return clock;
}
/** A previous run whose killed group takes `passes` more recovery passes to disappear. */
const dying = (passes: number) => ({
  recover: () => ({ killed: passes-- > 0 ? 1 : 0 }),
});

test("startup waits until a killed process group is gone before calling the previous run stopped", async () => {
  const clock = manualClock();
  await expect(verifyRecovery(dying(3), 10_000, clock)).resolves.toEqual({
    verified: true,
    unresolved: 0,
  });
  expect(clock.waited).toBeGreaterThan(0);
});

test("a killed group that outlives the bound leaves the previous run unverified", async () => {
  const clock = manualClock();
  await expect(verifyRecovery(dying(1_000), 1_000, clock)).resolves.toMatchObject({
    verified: false,
  });
  expect(clock.waited).toBeLessThanOrEqual(1_100);
});

test("a tree recovery could not prove stays unverified even when nothing is left to end", async () => {
  await expect(
    verifyRecovery({ recover: () => ({ killed: 0, unresolved: 2 }) }, 1_000, manualClock()),
  ).resolves.toEqual({ verified: false, unresolved: 2 });
});
