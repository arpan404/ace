import { expect, test } from "vitest";
import { CliTree, CommandId, ThreadId } from "@ace/protocol";
import {
  decideRun,
  runTreeState,
  stopPlan,
  type OpenWork,
  type RunFacts,
  type StopFacts,
} from "./automation-run-rules.ts";

const runId = "run-own";
const delivered = { state: "delivered" as const, runId: runId as never };
const ended = { active: false, last: "completed" as const };
const facts = (patch: Partial<RunFacts>): RunFacts => ({
  threadDeleted: false,
  fate: delivered,
  boundRun: runId,
  cancel: undefined,
  stopReached: false,
  turn: ended,
  tree: "ok",
  ...patch,
});
const idle: OpenWork = {
  tasks: 0,
  agentRuns: 0,
  questions: 0,
  reservations: 0,
  unowned: 0,
  continuing: false,
};
const none = CliTree.parse([]);
const child = (state: "working" | "done", cancelled = false) =>
  CliTree.parse([
    {
      threadId: "child",
      status: state === "working" ? { state, agents: 1 } : { state },
      pending: state === "working",
      queue: { revision: 0, paused: false, reason: null, resumeAt: null, uncertain: false },
      cancelled,
    },
  ]);
const root = (patch: Partial<CliTree[number]> = {}) => ({
  status: { state: "done" as const },
  attention: undefined,
  cancelled: false,
  ...patch,
});
const stoppedRoot = root({ attention: "stopped" });

test("a stopped run stays running while anything its turn began still works", () => {
  expect(decideRun(facts({ cancel: "sent", stopReached: true, tree: "working" }))).toEqual({
    kind: "wait",
  });
  expect(decideRun(facts({ cancel: "sent", turn: { active: true, last: "active" } }))).toEqual({
    kind: "wait",
  });
  expect(
    decideRun(
      facts({ cancel: "sent", turn: { active: false, last: "interrupted" }, tree: "failed" }),
    ),
  ).toEqual({ kind: "settle", status: "failed", result: "Stopped before it finished." });
  // A stop that cut the run's leftover work short reads as stopped, though its turn completed.
  expect(decideRun(facts({ cancel: "sent", stopReached: true }))).toEqual({
    kind: "settle",
    status: "failed",
    result: "Stopped before it finished.",
  });
  // A pause that found nothing left to stop keeps the turn's own result.
  expect(decideRun(facts({ cancel: "sent" }))).toMatchObject({
    kind: "settle",
    status: "succeeded",
  });
});

test("a Stop marker never ends a run whose background task, subagent or preparation still works", () => {
  for (const work of [
    { ...idle, tasks: 1 },
    { ...idle, agentRuns: 1 },
    { ...idle, reservations: 1 },
  ])
    expect(runTreeState({ root: stoppedRoot, work, children: none, cancelling: true })).toBe(
      "working",
    );
  expect(
    runTreeState({
      root: stoppedRoot,
      work: { ...idle, questions: 1 },
      children: none,
      cancelling: true,
    }),
  ).toBe("needs-human");
  // A thread held to carry the turn on beats its Stop marker too.
  expect(
    runTreeState({
      root: root({ attention: "stopped", status: { state: "waiting", on: "rate_limit" } }),
      work: idle,
      children: none,
      cancelling: true,
    }),
  ).toBe("working");
});

test("the thread reading as working because of others' work never holds the run open", () => {
  // Its status counts every working agent and delegated child; only the run's own are counted.
  expect(
    runTreeState({
      root: root({ status: { state: "working", agents: 2 } }),
      work: idle,
      children: none,
      cancelling: false,
    }),
  ).toBe("ok");
});

test("with nothing open, a run's own stop ends its turn, while a person's Stop waits on the person", () => {
  expect(runTreeState({ root: stoppedRoot, work: idle, children: none, cancelling: true })).toBe(
    "failed",
  );
  expect(runTreeState({ root: stoppedRoot, work: idle, children: none, cancelling: false })).toBe(
    "needs-human",
  );
  // Killed work never carries on, whoever stopped it.
  expect(
    runTreeState({
      root: { ...stoppedRoot, cancelled: true },
      work: idle,
      children: none,
      cancelling: false,
    }),
  ).toBe("failed");
});

test("a turn the provider says is coming for the run's work keeps the run open", () => {
  expect(
    runTreeState({
      root: root(),
      work: { ...idle, continuing: true },
      children: none,
      cancelling: false,
    }),
  ).toBe("working");
});

test("live delegated work nobody can say is the run's holds it open as uncertain", () => {
  expect(
    runTreeState({ root: root(), work: { ...idle, unowned: 1 }, children: none, cancelling: true }),
  ).toBe("uncertain");
});

test("a run whose delegated thread still works is not over, even after its root turn ended", () => {
  expect(
    runTreeState({ root: root(), work: idle, children: child("working"), cancelling: true }),
  ).toBe("working");
  expect(
    runTreeState({ root: root(), work: idle, children: child("done", true), cancelling: true }),
  ).toBe("failed");
});

test("a later turn in the thread neither holds the run open nor counts as its work", () => {
  // Once another turn started, only the run's own open work counts.
  expect(runTreeState({ root: undefined, work: idle, children: none, cancelling: false })).toBe(
    "ok",
  );
  expect(
    runTreeState({
      root: undefined,
      work: { ...idle, tasks: 1 },
      children: none,
      cancelling: false,
    }),
  ).toBe("working");
  // Messages others queued, held behind the thread's own queue, are not the run's work.
  expect(
    runTreeState({
      root: root({ status: { state: "waiting", on: "queue" } }),
      work: idle,
      children: none,
      cancelling: false,
    }),
  ).toBe("ok");
});

test("a run whose message the person took out ends with a reason, and a resend is followed", () => {
  expect(decideRun(facts({ fate: { state: "removed" }, boundRun: undefined }))).toEqual({
    kind: "settle",
    status: "failed",
    result: "Its message was taken out of the queue.",
  });
  expect(
    decideRun(facts({ fate: { state: "removed" }, boundRun: undefined, cancel: "sent" })),
  ).toEqual({ kind: "settle", status: "failed", result: "Stopped before it started." });
  const by = CommandId.parse("resent");
  expect(decideRun(facts({ fate: { state: "replaced", by } }))).toEqual({
    kind: "follow",
    commandId: by,
  });
  expect(decideRun(facts({ fate: { state: "uncertain" }, boundRun: undefined }))).toEqual({
    kind: "wait",
  });
});

test("a run settles with its turn's answer only after the turn it started", () => {
  expect(decideRun(facts({ fate: { state: "waiting" }, boundRun: undefined }))).toEqual({
    kind: "wait",
  });
  // Delivered but not yet taken by a run: the previous turn's end never closes this one.
  expect(decideRun(facts({ fate: { state: "delivered" }, boundRun: undefined }))).toEqual({
    kind: "wait",
  });
  expect(decideRun(facts({}))).toEqual({
    kind: "settle",
    status: "succeeded",
    fallback: "Finished without a written answer.",
  });
  // The engine forgot the message after it ran: the record's binding still stands.
  expect(decideRun(facts({ fate: { state: "unknown" } }))).toMatchObject({
    kind: "settle",
    status: "succeeded",
  });
  expect(decideRun(facts({ threadDeleted: true }))).toMatchObject({
    kind: "settle",
    status: "failed",
  });
});

const stopFacts = (patch: Partial<StopFacts>): StopFacts => ({
  fate: delivered,
  boundRun: runId,
  rootActive: undefined,
  tasks: [],
  agentRuns: [],
  liveChildren: [],
  reservations: [],
  ...patch,
});

test("stopping a run never interrupts a turn that is not its own", () => {
  const someoneElse = { runId: "run-other", ours: false };
  expect(stopPlan(stopFacts({ rootActive: someoneElse }))).toEqual({ kind: "none" });
  expect(stopPlan(stopFacts({ rootActive: { runId: "run-own-later", ours: true } }))).toEqual({
    kind: "interrupt",
    runId: "run-own-later",
  });
});

test("a run whose message no run has taken yet is never stopped by an unguarded interrupt", () => {
  // On its way, or delivered but not yet taken: whatever turn runs now could be anyone's.
  for (const fate of [{ state: "sending" as const }, { state: "delivered" as const }]) {
    expect(stopPlan(stopFacts({ fate, boundRun: undefined }))).toEqual({ kind: "wait" });
    expect(
      stopPlan(stopFacts({ fate, boundRun: undefined, rootActive: { runId: "x", ours: false } })),
    ).toEqual({ kind: "wait" });
  }
});

test("stopping a run takes a queued message out, and after its turn stops what that turn left", () => {
  expect(stopPlan(stopFacts({ fate: { state: "waiting" }, boundRun: undefined }))).toEqual({
    kind: "remove",
  });
  const children = [ThreadId.parse("child")];
  const reservations = [ThreadId.parse("reserved")];
  const agentRuns = [{ agentId: "sub", runId: "run-sub" }];
  // Left going while someone else's turn runs: still the run's own to stop, part by part.
  expect(
    stopPlan(
      stopFacts({
        rootActive: { runId: "run-other", ours: false },
        tasks: ["shell"],
        agentRuns,
        liveChildren: children,
        reservations,
      }),
    ),
  ).toEqual({ kind: "stop-work", tasks: ["shell"], agentRuns, children, reservations });
  expect(stopPlan(stopFacts({ fate: { state: "removed" }, boundRun: undefined }))).toEqual({
    kind: "none",
  });
});
