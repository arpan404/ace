import { expect, it } from "vitest";
import { networkIdle } from "./load-wait.ts";
import { TestNavigationClock } from "./navigation-test-clock.ts";

/** When (ms after it began) a network-idle wait returns, given what is in flight when. */
async function idleAt(inFlight: (now: number) => string[], limit = 30_000) {
  const clock = new TestNavigationClock();
  let returned: number | undefined;
  void networkIdle(
    { networkPending: () => inFlight(clock.now()) },
    clock,
    new AbortController().signal,
  ).then(() => {
    returned = clock.now();
  });
  for (let step = 0; step * 50 < limit; step++) {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    if (returned !== undefined) return returned;
    clock.advance(50);
  }
  return undefined;
}

it("network idle comes half a second after the page's last request finished", async () => {
  const at = await idleAt((now) => (now < 800 ? ["slow"] : []));
  expect(at).toBeGreaterThanOrEqual(1_300);
  expect(at).toBeLessThan(1_500);
});

it("a long poll or stream left open doesn't hold network idle until the timeout", async () => {
  // A dev server's reload channel: opened at once and never finished.
  const at = await idleAt((now) => (now < 800 ? ["poll", "slow"] : ["poll"]));
  expect(at).toBeDefined();
  expect(at).toBeLessThan(10_000);
});

it("requests that keep starting keep the network busy", async () => {
  // A new request every 300 ms, each done in 200 ms, for 8 seconds.
  const at = await idleAt((now) =>
    now < 8_000 && now % 300 < 200 ? [`r${Math.floor(now / 300)}`] : [],
  );
  expect(at).toBeGreaterThanOrEqual(8_000);
});
