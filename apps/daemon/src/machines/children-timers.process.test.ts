import { expect, it } from "vitest";
import { RECHECK_POLLS, RECHECK_WINDOW_MS } from "./child-recheck.ts";
import { defaultScheduleConfig } from "./child-schedule.ts";
import { HOUR, done, machine, working } from "./children-test-support.ts";
import { MachineFailure } from "./transport.ts";

/*
 * Properties a to e of the scheduler (child-schedule.ts), held by the real shell: a real ledger
 * on a temporary store, a fake clock and a fake machine, and nothing driving it but its own
 * timers. No test calls poll; each step runs the earliest timer at its time, as time passing does.
 */

const POLL = 1000;
const { callsPerTurn, idsPerCall } = defaultScheduleConfig(POLL, 0);

type Harness = ReturnType<typeof machine>;

/** Runs the earliest of the shell's timers at its time, and waits for the calls it made. */
async function next(h: Harness) {
  let earliest = 0;
  h.timers.forEach((timer, index) => {
    if (timer.at < (h.timers[earliest]?.at ?? Infinity)) earliest = index;
  });
  const [timer] = h.timers.splice(earliest, 1);
  if (timer) h.timers.unshift(timer);
  await h.step();
  await h.children.flush();
}

/**
 * Runs the shell's own timers until the clock passes `until`, checking `after` after every step;
 * returns when each call went out.
 */
async function run(h: Harness, until: number, after?: () => void) {
  const calls: { at: number; ids: string[] }[] = [];
  while (Math.min(...h.timers.map((timer) => timer.at)) <= until) {
    const before = h.asked.length;
    await next(h);
    for (const ids of h.asked.slice(before)) calls.push({ at: h.clock.now, ids });
    after?.();
  }
  return calls;
}

const gaps = (times: readonly number[]) =>
  times.slice(1).map((at, index) => at - (times[index] ?? at));
const timesOf = (calls: readonly { at: number; ids: string[] }[], id: string) =>
  calls.filter((call) => call.ids.includes(id)).map((call) => call.at);
/** The longest a child went unread over [from, to], its edges included; a child never read fails. */
function longestWait(times: readonly number[], from: number, to: number) {
  if (times.length === 0) throw new Error("never read");
  return Math.max(...gaps([from, ...times, to]));
}

it("a. every child is read within the stated bound on a machine of 301 working children", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const workers = Array.from({ length: 300 }, (_, index) =>
    h.add(`w-${String(index).padStart(3, "0")}`),
  );
  for (const id of workers) h.report(id, working);
  const settled = h.add("settled");
  h.report(settled, done("Done."));
  await run(h, h.clock.now + 5_000);
  expect(h.state(settled)).toBe("done");
  // It starts again there: from then on 301 children are working, none asked alone, so each is
  // read every ceil(301 / 256) = 2 polls at the most.
  h.report(settled, working);
  const from = h.clock.now;
  const until = from + 60_000;
  const calls = await run(h, until);
  const bound = Math.ceil(301 / (callsPerTurn * idsPerCall)) * POLL;
  // Noticed within its own re-check interval (10 s this young), then read like the rest.
  const reopened = timesOf(calls, settled).filter((at) => at > from + RECHECK_POLLS * POLL);
  expect(longestWait(reopened, from + (RECHECK_POLLS + 1) * POLL, until)).toBeLessThanOrEqual(
    bound,
  );
  for (const id of workers) {
    const times = timesOf(calls, id);
    expect(longestWait(times, from, until), id).toBeLessThanOrEqual(bound);
    expect(times.length, id).toBeGreaterThanOrEqual(Math.floor((until - from) / bound));
  }
  expect(h.state(settled)).toBe("working");
});

it("b. a child whose call failed beside others is never batched again until it has answered alone", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const ids = Array.from({ length: 30 }, (_, index) => h.add(`c-${index}`));
  for (const id of ids) h.report(id, working);
  // Any call asking about c-7 with another loses its connection; alone it answers.
  h.reads.decide = (asked) =>
    asked.length > 1 && asked.includes("c-7") ? new MachineFailure("disconnected") : undefined;
  const calls = await run(h, h.clock.now + 10 * 60_000);
  const tainted = new Set<string>();
  let failedShared = 0;
  for (const call of calls) {
    if (call.ids.length > 1) for (const id of call.ids) expect(tainted.has(id), id).toBe(false);
    const failed = call.ids.length > 1 && call.ids.includes("c-7");
    if (failed) {
      failedShared++;
      for (const id of call.ids) tainted.add(id);
    } else if (call.ids.length === 1 && call.ids[0]) tainted.delete(call.ids[0]);
  }
  // It rejoined now and then, each time alone for twice as long: a handful in ten minutes.
  expect(failedShared).toBeGreaterThan(0);
  expect(failedShared).toBeLessThanOrEqual(Math.ceil(Math.log2(600 / RECHECK_POLLS)) + 2);
});

it("c. a child failing alone backs off to the cap, though its machine answers and recovers every turn", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const failing = h.add("failing");
  const healthy = h.add("healthy");
  h.report(failing, working);
  h.report(healthy, working);
  h.reads.decide = (asked) =>
    asked.includes("failing") ? new MachineFailure("disconnected") : undefined;
  // As the directory does: a call getting through says the machine is reachable again.
  h.reads.answered = (host) => h.children.machineReachable(host);
  await run(h, h.clock.now + 3 * 60_000);
  const calls = await run(h, h.clock.now + 60_000);
  expect(timesOf(calls, "failing").length).toBeLessThanOrEqual(3);
  expect(timesOf(calls, "healthy").length).toBeGreaterThanOrEqual(55);
});

it("d. a settled child leaves tracking only after a check answered at or after its 24 h mark", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const id = h.add("child");
  h.report(id, done("Done."));
  await run(h, h.clock.now + 5_000);
  const settledAt = h.clock.now;
  // Unreachable from before its mark until well after it: it stays tracked, asked at its backoff.
  await run(h, settledAt + RECHECK_WINDOW_MS - HOUR);
  h.reads.error = new MachineFailure("offline");
  const silent = await run(h, settledAt + RECHECK_WINDOW_MS + 2 * HOUR);
  expect(silent.length).toBeGreaterThan(0);
  h.reads.error = undefined;
  h.report(id, working);
  await run(h, h.clock.now + 60_000);
  expect(h.state(id)).toBe("working");
});

it("e. a child past its 24 h mark is read every 10 s until it answers, then let go", async () => {
  const first = machine(undefined, { pollMs: POLL });
  const id = first.add("child");
  first.report(id, done("Done."));
  await run(first, first.clock.now + 5_000);
  first.children.close();
  // Back two days later: the child is past its mark, and its machine answers only at the third try.
  const h = machine(first.home, { pollMs: POLL, startAt: first.clock.now + 2 * RECHECK_WINDOW_MS });
  h.report(id, done("Done."));
  let tries = 0;
  h.reads.decide = () => (++tries < 3 ? new MachineFailure("offline") : undefined);
  const calls = await run(h, h.clock.now + 5 * 60_000);
  const times = timesOf(calls, id);
  expect(times.length).toBe(3);
  for (const gap of gaps(times)) expect(gap).toBeLessThanOrEqual(RECHECK_POLLS * POLL);
  // Answered past its mark: it leaves tracking, and nothing more is asked or scheduled.
  expect(h.timers).toEqual([]);
});

it("a poll is still set after the pairings could not be read while only settled children remain", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const id = h.add("child");
  h.report(id, done("Done."));
  await run(h, h.clock.now + 5_000);
  expect(h.state(id)).toBe("done");
  // The pairings database is unreadable for the one poll and the re-arm after it.
  h.faults.unreadablePairings = true;
  await next(h);
  h.faults.unreadablePairings = false;
  expect(h.timers.length).toBeGreaterThan(0);
  // It starts again there and its parent sees it.
  h.report(id, working);
  await run(h, h.clock.now + 6 * 60_000);
  expect(h.state(id)).toBe("working");
});

it("while children are tracked a timer is always armed, whatever the pairings, store and machine do", async () => {
  // A small seeded generator, so a failing run can be replayed.
  for (const seed of [1, 2, 3, 4]) {
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state / 2 ** 32;
    };
    const h = machine(undefined, { pollMs: POLL });
    const settled = ["s-0", "s-1", "s-2"].map((id) => h.add(id));
    for (const id of settled) h.report(id, done("Done."));
    const workers = seed % 2 === 0 ? [h.add("w-0")] : [];
    for (const id of workers) h.report(id, working);
    await run(h, h.clock.now + 5_000);
    const fragments = ["machine_children", "settled=1", "settled=0", "rechecked", "lost_at"];
    // Each step may break any dependency the shell reads, for that step or for longer.
    await run(h, h.clock.now + 20 * 60_000, () => {
      expect(h.timers.length, `seed ${seed} at ${h.clock.now}`).toBeGreaterThan(0);
      const roll = random();
      h.faults.unreadablePairings =
        roll < 0.15 ? true : roll < 0.3 ? false : h.faults.unreadablePairings;
      if (random() < 0.15) h.faults.failNextWrite = true;
      if (random() < 0.15) h.faults.failSql = fragments[Math.floor(random() * fragments.length)];
      const read = random();
      h.reads.error =
        read < 0.1 ? new MachineFailure("offline") : read < 0.3 ? undefined : h.reads.error;
    });
    // Everything readable again: a settled child that started again there is noticed.
    h.faults.unreadablePairings = false;
    h.faults.failNextWrite = false;
    h.faults.failSql = undefined;
    h.reads.error = undefined;
    h.report("s-1", working);
    for (const id of workers) h.report(id, done("Done."));
    await run(h, h.clock.now + 10 * 60_000);
    expect(h.state("s-1"), `seed ${seed}`).toBe("working");
    for (const id of workers) expect(h.state(id), `seed ${seed}`).toBe("done");
    h.children.close();
  }
}, 60_000);
