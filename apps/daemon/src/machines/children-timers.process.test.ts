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

/** A machine whose children were all saved as asked alone, as after a restart following failures. */
async function restartedWithBacklog(n: number, options: Parameters<typeof machine>[1] = {}) {
  const first = machine(undefined, { pollMs: POLL });
  const ids = Array.from({ length: n }, (_, index) =>
    first.add(`w-${String(index).padStart(4, "0")}`),
  );
  for (const id of ids) first.report(id, working);
  await run(first, first.clock.now + 2_000);
  // Shared calls fail until every child has been in one: each is saved as asked alone.
  const caught = new Set<string>();
  first.reads.decide = (asked) => {
    if (asked.length < 2) return undefined;
    for (const id of asked) caught.add(id);
    return new MachineFailure("disconnected");
  };
  while (caught.size < n) await run(first, first.clock.now + POLL);
  first.children.close();
  const h = machine(first.home, { pollMs: POLL, startAt: first.clock.now + POLL, ...options });
  for (const id of ids) h.report(id, working);
  return { h, ids };
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

it("c. a child alone on its machine backs off to the cap while describe calls there succeed between polls", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const failing = h.add("failing");
  h.report(failing, working);
  h.reads.error = new MachineFailure("disconnected");
  const described = () => h.children.machineReachable("studio");
  // Something else here reads its description after every poll, and gets an answer.
  await run(h, h.clock.now + 3 * 60_000, described);
  const calls = await run(h, h.clock.now + 60_000, described);
  expect(timesOf(calls, "failing").length).toBeLessThanOrEqual(3);
});

it("c. a lone child on a machine that was down is read again as soon as the machine answers", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const child = h.add("child");
  h.report(child, working);
  h.reads.error = new MachineFailure("offline");
  await run(h, h.clock.now + 3 * 60_000);
  h.reads.error = undefined;
  h.report(child, done("Done."));
  // A describe gets through: the machine is back, so its child's wait is the machine's and ends.
  h.children.machineReachable("studio");
  await run(h, h.clock.now + 2 * POLL);
  expect(h.state(child)).toBe("done");
});

it("c. a child failing alone keeps its own wait while its machine goes down and comes back", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const failing = h.add("failing");
  const healthy = h.add("healthy");
  h.report(failing, working);
  h.report(healthy, working);
  // Up four polls, down four: every eight seconds the machine comes back.
  const down = () => Math.floor(h.clock.now / (4 * POLL)) % 2 === 1;
  h.reads.decide = (asked) =>
    down() || asked.includes("failing") ? new MachineFailure("offline") : undefined;
  h.reads.answered = (host) => h.children.machineReachable(host);
  await run(h, h.clock.now + 3 * 60_000);
  const calls = await run(h, h.clock.now + 60_000);
  // Its own wait is at the 30 s cap; the machine's seven recoveries a minute don't end it.
  expect(timesOf(calls, "failing").length).toBeLessThanOrEqual(5);
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

it("e. a settled child is checked within 10 s of its 24 h mark, however long its interval was", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const id = h.add("child");
  h.report(id, done("Done."));
  await run(h, h.clock.now + 5_000);
  const mark = h.clock.now + RECHECK_WINDOW_MS;
  // Checked every five minutes by then.
  await run(h, mark - 1);
  const calls = await run(h, mark + 6 * 60_000);
  const first = timesOf(calls, id).find((at) => at >= mark);
  expect(first).toBeDefined();
  expect((first ?? Infinity) - mark).toBeLessThanOrEqual(RECHECK_POLLS * POLL + POLL);
});

it("e. a child stopped without confirmation is read every 10 s while its machine says it still works", async () => {
  const h = machine(undefined, { pollMs: POLL, stopPlan: [{ action: "cancel", waitMs: 2_000 }] });
  const id = h.add("child");
  h.report(id, working);
  await run(h, h.clock.now + 2_000);
  h.children.stop(id);
  await run(h, h.clock.now + 10_000);
  expect(h.children.watched(id)?.view.contact).toBe("unconfirmed");
  const from = h.clock.now;
  const calls = await run(h, from + 5 * 60_000);
  expect(longestWait(timesOf(calls, id), from, from + 5 * 60_000)).toBeLessThanOrEqual(
    RECHECK_POLLS * POLL,
  );
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
}, 30_000);

it("no healthy child loses contact or its parent's hold while 400 wait their turn to be asked alone", async () => {
  // 400 children asked alone, 16 a turn, take 25 s to reach: well past a 10 s lease.
  const { h, ids } = await restartedWithBacklog(400, { leaseMs: 10_000 });
  const lost = new Set<string>();
  const calls = await run(h, h.clock.now + 40_000, () => {
    for (const id of ids) if (h.children.watched(id)?.view.contact === "lost") lost.add(id);
  });
  expect([...lost]).toEqual([]);
  for (const id of ids) expect(timesOf(calls, id).length, id).toBeGreaterThan(0);
});

it("a child that is asked and never answers still loses contact after the lease", async () => {
  const { h, ids } = await restartedWithBacklog(40, { leaseMs: 10_000 });
  const [silent] = ids;
  if (!silent) throw new Error("no child");
  h.reads.decide = (asked) => (asked.includes(silent) ? new MachineFailure("offline") : undefined);
  await run(h, h.clock.now + 30_000);
  expect(h.children.watched(silent)?.view.contact).toBe("lost");
  expect(ids.slice(1).filter((id) => h.children.watched(id)?.view.contact === "lost")).toEqual([]);
});

it("stops are confirmed, never given up on, while forty of them wait behind 400 children asked alone", async () => {
  const { h, ids } = await restartedWithBacklog(400, {
    stopPlan: [{ action: "cancel", waitMs: 2_000 }],
  });
  // Its machine takes each cancel at once; only a read of the child can say so.
  h.answers.cancel = async (id) => {
    h.report(id, { state: "cancelled", status: { state: "done" }, result: "Stopped." });
  };
  const stopped = ids.slice(-40);
  const from = h.clock.now;
  for (const id of stopped) h.children.stop(id);
  const unconfirmed = new Set<string>();
  const confirmedAt = new Map<string, number>();
  await run(h, from + 40_000, () => {
    for (const id of stopped) {
      const view = h.children.watched(id)?.view;
      if (view?.contact === "unconfirmed") unconfirmed.add(id);
      if (view?.state === "cancelled" && !confirmedAt.has(id)) confirmedAt.set(id, h.clock.now);
    }
  });
  // More than one turn's sixteen calls: the last are read after the 2 s bound, and still wait.
  expect([...unconfirmed]).toEqual([]);
  // Asked ahead of the 400, sixteen a turn: all confirmed within ceil(40 / 16) polls and one more.
  expect(confirmedAt.size).toBe(40);
  const slowest = Math.max(...confirmedAt.values()) - from;
  expect(slowest).toBeLessThanOrEqual((Math.ceil(40 / callsPerTurn) + 1) * POLL);
});

it("a child whose first read after a backlog fails loses contact only a lease after that read", async () => {
  const { h, ids } = await restartedWithBacklog(400, { leaseMs: 10_000 });
  const failedOnce = new Set<string>();
  // Each child's first read fails, then it answers every time.
  h.reads.decide = (asked) => {
    const fresh = asked.filter((id) => !failedOnce.has(id));
    for (const id of fresh) failedOnce.add(id);
    return fresh.length > 0 ? new MachineFailure("disconnected") : undefined;
  };
  const lost = new Set<string>();
  await run(h, h.clock.now + 60_000, () => {
    for (const id of ids) if (h.children.watched(id)?.view.contact === "lost") lost.add(id);
  });
  expect(failedOnce.size).toBe(400);
  expect([...lost]).toEqual([]);
});
