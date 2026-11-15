import { expect, it } from "vitest";
import { RECHECK_POLLS, RECHECK_SLOWEST_POLLS, RECHECK_WINDOW_MS } from "./child-recheck.ts";
import { HOUR, POLL_MS, done, machine, working } from "./children-test-support.ts";

/*
 * The re-check of settled children on other machines (ADR 0099) slows as they age, but never
 * lets a child leave tracking, or sit on the slow pace, without a check after the last thing that
 * could have reopened it unseen: this daemon restarting, its machine being unreachable, or the
 * child reaching the end of the 24-hour window.
 */

/** Steps polls until the clock passes `until`. */
async function runUntil(h: ReturnType<typeof machine>, until: number) {
  while (h.timers.length > 0 && (h.timers[0]?.at ?? Infinity) <= until) await h.step();
}

it("a child that settled almost a day ago and runs again there is noticed soon after a restart", async () => {
  const first = machine();
  const ids = Array.from({ length: 20 }, (_, index) => first.add(`child-${index}`));
  for (const id of ids) first.report(id, done("Done."));
  await first.step();
  for (const id of ids) expect(first.state(id)).toBe("done");
  const settledAt = first.clock.now;
  first.children.close();

  // The daemon comes back 23 h 58 min later; meanwhile work started again on every child there.
  const startAt = settledAt + RECHECK_WINDOW_MS - 2 * 60 * 1000;
  const restarted = machine(first.home, { startAt });
  for (const id of ids) restarted.report(id, working);
  // Every saved settled child is read at the fast pace, sixteen per call, before any slows down.
  await runUntil(restarted, startAt + 2 * POLL_MS * RECHECK_POLLS + POLL_MS);
  for (const id of ids) expect(restarted.state(id), id).toBe("working");
});

it("a child reaching the end of the window gets one last check before it leaves tracking", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("Done."));
  await h.step();
  const settledAt = h.clock.now;
  // Every check up to the end of the window, then work starts again there right after.
  await runUntil(h, settledAt + RECHECK_WINDOW_MS - 1);
  h.report(id, working);
  await runUntil(h, settledAt + RECHECK_WINDOW_MS + 2 * POLL_MS * RECHECK_SLOWEST_POLLS);
  expect(h.state(id)).toBe("working");
});

it("a child checked for the last time stops being asked about", async () => {
  const h = machine();
  const id = h.add("child");
  h.report(id, done("Done."));
  await h.step();
  const settledAt = h.clock.now;
  await runUntil(h, settledAt + RECHECK_WINDOW_MS + 2 * POLL_MS * RECHECK_SLOWEST_POLLS);
  const asked = h.asked.length;
  h.clock.now += HOUR;
  if (h.timers.length > 0) await h.fire();
  expect(h.asked.length).toBe(asked);
  expect(h.timers).toEqual([]);
});

it("a re-check that failed does not count: the child is read once its machine answers again", async () => {
  // The shipped one-second poll, so the slow pace is 5 minutes and the bound below is real.
  const h = machine(undefined, { pollMs: 1000 });
  const id = h.add("child");
  h.report(id, done("Done."));
  await h.step();
  // Hours later, on the slow pace, the machine can't be reached for one re-check.
  await runUntil(h, h.clock.now + 5 * HOUR);
  h.reads.error = new Error("Studio is unreachable");
  const before = h.asked.length;
  while (h.asked.length === before) await h.step();
  // Work started there while it couldn't be read; the next read comes as soon as it answers.
  h.reads.error = undefined;
  h.report(id, working);
  const failedAt = h.clock.now;
  await runUntil(h, failedAt + 30_000);
  expect(h.state(id)).toBe("working");
});

it("a child that ran again while its machine was unreachable past the window is read once it answers", async () => {
  const h = machine(undefined, { pollMs: 1000 });
  const id = h.add("child");
  h.report(id, done("Done."));
  await h.step();
  const settledAt = h.clock.now;
  await runUntil(h, settledAt + RECHECK_WINDOW_MS - 60_000);
  // Just before its 24 h mark it starts again there, and its machine can't be reached for hours.
  h.report(id, working);
  h.reads.error = new Error("Studio is unreachable");
  await runUntil(h, settledAt + RECHECK_WINDOW_MS + 3 * HOUR);
  expect(h.state(id)).toBe("done");
  h.reads.error = undefined;
  await runUntil(h, h.clock.now + 60_000);
  expect(h.state(id)).toBe("working");
});

it("a child past the window when the daemon restarts is still read once before it is let go", async () => {
  const first = machine();
  const id = first.add("child");
  first.report(id, done("Done."));
  await first.step();
  const settledAt = first.clock.now;
  first.children.close();
  // The daemon was off for two days; the child started again there meanwhile.
  const restarted = machine(first.home, { startAt: settledAt + 2 * RECHECK_WINDOW_MS });
  restarted.report(id, working);
  await runUntil(restarted, restarted.clock.now + 2 * POLL_MS * RECHECK_POLLS);
  expect(restarted.state(id)).toBe("working");
});

it("sixty-four children settling together are each read after their 24 h mark", async () => {
  const h = machine(undefined, { pollMs: 1000 });
  const ids = Array.from({ length: 64 }, (_, index) => h.add(`child-${index}`));
  for (const id of ids) h.report(id, done("Done."));
  await h.step();
  const settledAt = h.clock.now;
  await runUntil(h, settledAt + RECHECK_WINDOW_MS - 1);
  // Right at the end of the window every one of them starts again there.
  for (const id of ids) h.report(id, working);
  await runUntil(h, settledAt + RECHECK_WINDOW_MS + 30 * 60 * 1000);
  for (const id of ids) expect(h.state(id), id).toBe("working");
});

it("a child read after its 24 h mark leaves tracking for good, even across a restart", async () => {
  const first = machine();
  const id = first.add("child");
  first.report(id, done("Done."));
  await first.step();
  const settledAt = first.clock.now;
  await runUntil(first, settledAt + RECHECK_WINDOW_MS + 2 * POLL_MS * RECHECK_SLOWEST_POLLS);
  expect(first.timers).toEqual([]);
  first.children.close();
  const restarted = machine(first.home, { startAt: settledAt + 2 * RECHECK_WINDOW_MS });
  expect(restarted.timers).toEqual([]);
  expect(restarted.asked).toEqual([]);
});
