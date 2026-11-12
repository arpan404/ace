import type { AutomationRun } from "@ace/protocol";
import { expect, test } from "vitest";
import { RunWatch, type RunAlert } from "./run-alerts.ts";

/* Automation-run alerts on the phone: the inbox read while a run could finish, each finish said once. */

const start = 1_000_000;

function run(id: string, patch: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id,
    automationId: "nightly",
    title: "Nightly audit",
    eventKey: id,
    trigger: "schedule",
    status: "running",
    startedAt: start - 10,
    ...patch,
  };
}

async function settle() {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

/** What one read of the inbox gets: its runs, the machine's refusal, or no answer at all. */
type Read = AutomationRun[] | "refused" | "lost";

function watch(inbox: (at: number) => Read) {
  let now = start;
  const timers: { at: number; run: () => void }[] = [];
  const said: RunAlert[] = [];
  const runs = new RunWatch(
    async () => {
      const read = inbox(now);
      if (read === "lost") throw new Error("socket closed");
      return read === "refused"
        ? { ok: false, error: "unavailable" }
        : { ok: true, inbox: { runs: read } };
    },
    (delay, go) => {
      const timer = { at: now + delay, run: go };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    () => now,
    (alert) => said.push(alert),
  );
  /** Moves the clock to the next timer and runs it; returns how long it waited. */
  const next = async () => {
    const timer = timers.toSorted((a, b) => a.at - b.at)[0];
    if (!timer) return undefined;
    timers.splice(timers.indexOf(timer), 1);
    const waited = timer.at - now;
    now = timer.at;
    timer.run();
    await settle();
    return waited;
  };
  const advance = (ms: number) => {
    now += ms;
  };
  return { runs, said, next, settle, advance, timers };
}

test("a run that finishes while watched is said once, by its title, opening its thread", async () => {
  let finished = false;
  const phone = watch((at) => [
    finished
      ? run("r1", { status: "failed", finishedAt: at, threadId: "t-9", result: "token=abc" })
      : run("r1"),
  ]);
  phone.runs.start();
  await phone.settle();
  expect(phone.said).toEqual([]);
  // A run still going is checked on every few seconds, as on the web.
  finished = true;
  expect(await phone.next()).toBe(5_000);
  expect(phone.said).toEqual([
    {
      key: "r1",
      title: "Nightly audit failed",
      body: "The automation run failed",
      threadId: "t-9",
      automationId: "nightly",
    },
  ]);
  // Nothing running: read once a minute, and the same finish is never said again.
  expect(await phone.next()).toBe(60_000);
  expect(phone.said).toHaveLength(1);
});

test("runs that finished before the phone started watching are history", async () => {
  const phone = watch(() => [run("old", { status: "succeeded", finishedAt: start - 5 })]);
  phone.runs.start();
  await phone.settle();
  await phone.next();
  expect(phone.said).toEqual([]);
});

test("a run that finished while the connection was down is said when it comes back", async () => {
  let done: number | undefined;
  const phone = watch(() => [
    done === undefined ? run("r1") : run("r1", { status: "succeeded", finishedAt: done }),
  ]);
  phone.runs.start();
  await phone.settle();
  phone.runs.stop();
  expect(phone.timers).toEqual([]);
  phone.advance(30_000);
  done = start + 20_000;
  phone.runs.start();
  await phone.settle();
  expect(phone.said.map((alert) => alert.title)).toEqual(["Nightly audit finished"]);
});

test("a run that finished while its alerts were turned off is never said later", async () => {
  let done: number | undefined;
  const phone = watch(() =>
    done === undefined ? [] : [run("r1", { status: "succeeded", finishedAt: done })],
  );
  phone.runs.start();
  await phone.settle();
  phone.runs.forget();
  phone.advance(30_000);
  done = start + 20_000;
  phone.runs.start();
  await phone.settle();
  expect(phone.said).toEqual([]);
});

test("a read the machine refuses or never answers says nothing again, then or later", async () => {
  const done = run("r1", { status: "succeeded", finishedAt: start + 1 });
  const reads: Read[] = [[done], "refused", "lost", [done]];
  const phone = watch(() => reads.shift() ?? [done]);
  phone.runs.start();
  await phone.settle();
  expect(phone.said.map((alert) => alert.key)).toEqual(["r1"]);
  for (let i = 0; i < 3; i++) await phone.next();
  // Still the one alert: a failed read is no reading, so it forgets nothing it said.
  expect(phone.said.map((alert) => alert.key)).toEqual(["r1"]);
});
