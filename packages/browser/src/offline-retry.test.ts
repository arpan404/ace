import { expect, it } from "vitest";
import { OfflineRetries } from "./offline-retry.ts";

function clock() {
  let now = 0;
  const timers: { at: number; work: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    set(delay: number, work: () => void) {
      const timer = { at: now + delay, work, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0))
        if (timer.cancelled) continue;
        else if (timer.at <= now) timer.work();
        else timers.push(timer);
    },
  };
}
const offline = { tabId: "tab", loading: false, loadError: "net::ERR_INTERNET_DISCONNECTED" };

it("an offline page is reloaded with growing pauses until it loads", () => {
  const time = clock();
  const reloads: number[] = [];
  const retries = new OfflineRetries(time, async () => void reloads.push(time.now()));
  retries.update([offline]);
  time.advance(2_000);
  expect(reloads).toEqual([2_000]);
  // The retry loads and fails again: the next pause doubles.
  retries.update([{ ...offline, loading: true }]);
  retries.update([offline]);
  time.advance(3_999);
  expect(reloads).toEqual([2_000]);
  time.advance(1);
  expect(reloads).toEqual([2_000, 6_000]);
  retries.update([{ tabId: "tab", loading: false }]);
  retries.update([offline]);
  time.advance(2_000);
  // A load that worked starts the count over.
  expect(reloads).toEqual([2_000, 6_000, 8_000]);
});

it("a page that failed for another reason, or a closed tab, is left alone", () => {
  const time = clock();
  const reloads: string[] = [];
  const retries = new OfflineRetries(time, async (tabId) => void reloads.push(tabId));
  retries.update([
    { tabId: "down", loading: false, loadError: "net::ERR_CONNECTION_REFUSED" },
    offline,
  ]);
  retries.update([]);
  time.advance(60_000);
  expect(reloads).toEqual([]);
});
