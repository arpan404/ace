import { expect, test } from "vitest";
import { mediaRetryCooldownMs, mediaRetryDelaysMs } from "./media-route.ts";
import { SubscribeRetry } from "./subscribe-retry.ts";

/** A clock the test moves, and the ladder of one source as `MediaSubscriptions` keeps it. */
function source() {
  let now = 0;
  const timers: { at: number; run: () => void }[] = [];
  const schedule = (run: () => void, ms: number) => {
    const timer = { at: now + ms, run };
    timers.push(timer);
    return () => void timers.splice(timers.indexOf(timer), 1);
  };
  let attempt = 0;
  let gaveUp = false;
  const ladder = {
    retryDelay: () => mediaRetryDelaysMs[attempt++],
    giveUp: () => void (gaveUp = true),
  };
  const tries: number[] = [];
  const retry = new SubscribeRetry(ladder, "thread", schedule);
  const fail = () => retry.failed(() => tries.push(now));
  const advance = (ms: number) => {
    now += ms;
    for (const timer of timers.filter((t) => t.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  return { retry, fail, advance, tries, gaveUp: () => gaveUp };
}

test("each failure waits the ladder's next step, then the cooldown, giving up the connection", () => {
  const s = source();
  for (const wait of mediaRetryDelaysMs) {
    s.fail();
    s.advance(wait - 1);
    expect(s.retry.waiting).toBe(true);
    s.advance(1);
    expect(s.retry.waiting).toBe(false);
  }
  expect(s.tries).toHaveLength(mediaRetryDelaysMs.length);
  s.fail();
  expect(s.gaveUp()).toBe(true);
  s.advance(mediaRetryCooldownMs - 1);
  expect(s.tries).toHaveLength(mediaRetryDelaysMs.length);
  s.advance(1);
  expect(s.tries).toHaveLength(mediaRetryDelaysMs.length + 1);
});

test("one event may skip a step's wait, the next one waits it out", () => {
  const s = source();
  s.fail();
  expect(s.retry.event()).toBe(true);
  expect(s.retry.waiting).toBe(false);
  s.fail();
  expect(s.retry.event()).toBe(true);
  // A new step after a failure: one skip again, then none.
  s.retry.failed(() => {});
  expect(s.retry.event()).toBe(true);
});

test("no event skips the cooldown", () => {
  const s = source();
  for (const _ of mediaRetryDelaysMs) {
    s.fail();
    s.advance(10_000);
  }
  s.fail();
  for (let i = 0; i < 5; i++) expect(s.retry.event()).toBe(false);
  expect(s.retry.waiting).toBe(true);
});

test("without a wait pending, an event goes at once; a stopped retry runs nothing", () => {
  const s = source();
  expect(s.retry.event()).toBe(true);
  s.fail();
  s.retry.stop();
  s.advance(60_000);
  expect(s.tries).toEqual([]);
  expect(s.retry.waiting).toBe(false);
});
