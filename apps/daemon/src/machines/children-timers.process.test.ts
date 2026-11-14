import { expect, it } from "vitest";
import { RECHECK_POLLS, RECHECK_WINDOW_MS } from "./child-recheck.ts";
import { defaultScheduleConfig } from "./child-schedule.ts";
import { HOUR, done, machine, working } from "./children-test-support.ts";
import { MachineFailure } from "./transport.ts";

/*
 * Properties a to e of the scheduler (child-schedule.ts), held by the real shell: a real ledger
 * on a temporary store, a fake clock and a fake machine, and nothing driving it but its own
 * timers. No test calls poll; each step runs the next timer at its time, as time passing does.
 */

const POLL = 1000;
const { callsPerTurn } = defaultScheduleConfig(POLL, 0);

/** Runs the shell's own timers until the clock passes `until`; returns when each call went out. */
async function run(h: ReturnType<typeof machine>, until: number) {
  const calls: { at: number; ids: string[] }[] = [];
  while (h.timers.length > 0 && (h.timers[0]?.at ?? Infinity) <= until) {
    const before = h.asked.length;
    await h.step();
    await h.children.flush();
    for (const ids of h.asked.slice(before)) calls.push({ at: h.clock.now, ids });
  }
  return calls;
}

const gaps = (times: readonly number[]) =>
  times.slice(1).map((at, index) => at - (times[index] ?? at));
const timesOf = (calls: readonly { at: number; ids: string[] }[], id: string) =>
  calls.filter((call) => call.ids.includes(id)).map((call) => call.at);

it("a. every child is asked within the bound on a machine of 300 working children and a settled one", async () => {
  const h = machine(undefined, { pollMs: POLL });
  const workers = Array.from({ length: 300 }, (_, index) =>
    h.add(`w-${String(index).padStart(3, "0")}`),
  );
  for (const id of workers) h.report(id, working);
  const settled = h.add("settled");
  h.report(settled, done("Done."));
  const start = h.clock.now;
  await run(h, start + 5_000);
  expect(h.state(settled)).toBe("done");
  // It starts again there; it is read within its own interval plus the bound.
  h.report(settled, working);
  const reopened = h.clock.now;
  const calls = await run(h, reopened + 60_000);
  const turns = Math.ceil(301 / callsPerTurn) + 1;
  for (const id of workers)
    expect(Math.max(...gaps(timesOf(calls, id))), id).toBeLessThanOrEqual((turns + 1) * POLL);
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
  for (const call of calls) {
    if (call.ids.length > 1) for (const id of call.ids) expect(tainted.has(id), id).toBe(false);
    const failed = call.ids.length > 1 && call.ids.includes("c-7");
    if (failed) for (const id of call.ids) tainted.add(id);
    else if (call.ids.length === 1 && call.ids[0]) tainted.delete(call.ids[0]);
  }
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
