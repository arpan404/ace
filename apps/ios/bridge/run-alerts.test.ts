import type { AutomationRun } from "@ace/protocol";
import { expect, test } from "vitest";
import type { KeptValue } from "./kept-value.ts";
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
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** This machine's kept value on the phone, as the host keeps it; its first `failLoads` reads fail. */
function memoryKept(failLoads = 0, initial?: unknown): KeptValue & { readonly value: unknown } {
  let value = initial;
  let failing = failLoads;
  return {
    get value() {
      return value;
    },
    load: async () => {
      if (failing-- > 0) throw new Error("storage.value.load failed");
      return value;
    },
    save: async (next) => {
      value = next;
    },
  };
}

/** What one read of the inbox gets: its runs, the machine's refusal, or no answer at all. */
type Read = AutomationRun[] | "refused" | "lost";

/** A watch on the phone; `kept` is what it keeps between launches, `at` when this launch began. */
function watch(inbox: (at: number) => Read, options: { kept?: KeptValue; at?: number } = {}) {
  let now = options.at ?? start;
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
    options.kept,
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

test("a run that finished while the phone was closed is said when it opens again, once", async () => {
  const kept = memoryKept();
  let done: number | undefined;
  const inbox = () => [
    done === undefined ? run("r1") : run("r1", { status: "succeeded", finishedAt: done }),
  ];
  const first = watch(inbox, { kept });
  first.runs.start();
  await first.settle();
  // ace closes; the run finishes an hour before it opens again.
  first.runs.stop();
  done = start + 60_000;
  const later = watch(inbox, { kept, at: start + 3_600_000 });
  later.runs.start();
  await later.settle();
  expect(later.said.map((alert) => alert.key)).toEqual(["r1"]);
  const again = watch(inbox, { kept, at: start + 7_200_000 });
  again.runs.start();
  await again.settle();
  expect(again.said).toEqual([]);
});

test("runs that finish while run alerts are off stay unsaid after a relaunch too", async () => {
  const kept = memoryKept();
  let done: number | undefined;
  const inbox = () =>
    done === undefined ? [] : [run("r1", { status: "succeeded", finishedAt: done })];
  const first = watch(inbox, { kept });
  first.runs.start();
  await first.settle();
  first.runs.forget();
  done = start + 20_000;
  const later = watch(inbox, { kept, at: start + 60_000 });
  later.runs.start();
  await later.settle();
  expect(later.said).toEqual([]);
});

test("progress the phone can't read back is never saved over", async () => {
  const kept = memoryKept(1, { since: start - 5 });
  const phone = watch(() => [run("r1", { status: "succeeded", finishedAt: start + 1 })], { kept });
  phone.runs.start();
  await phone.settle();
  expect(phone.said.map((alert) => alert.key)).toEqual(["r1"]);
  expect(kept.value).toEqual({ since: start - 5 });
});

test("alerts off from launch, then on: what finished meanwhile stays unsaid after the next launch", async () => {
  // The last launch had said everything up to start - 100.
  const kept = memoryKept(0, { since: start - 100 });
  const inbox = () => [run("r1", { status: "succeeded", finishedAt: start - 50 })];
  const first = watch(inbox, { kept });
  first.runs.forget();
  first.runs.start();
  await first.settle();
  expect(first.said).toEqual([]);
  first.runs.stop();
  const later = watch(inbox, { kept, at: start + 60_000 });
  later.runs.start();
  await later.settle();
  expect(later.said).toEqual([]);
});
