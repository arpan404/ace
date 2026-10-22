import { expect, test } from "vitest";
import { CliTree, CommandId, ThreadId } from "@ace/protocol";
import {
  decideRun,
  runTreeState,
  stopPlan,
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
  turn: ended,
  tree: "ok",
  ...patch,
});
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

test("a stopped run stays running while anything its turn began still works", () => {
  expect(decideRun(facts({ cancel: "sent", tree: "working" }))).toEqual({ kind: "wait" });
  expect(decideRun(facts({ cancel: "sent", turn: { active: true, last: "active" } }))).toEqual({
    kind: "wait",
  });
  expect(
    decideRun(
      facts({ cancel: "sent", turn: { active: false, last: "interrupted" }, tree: "failed" }),
    ),
  ).toEqual({ kind: "settle", status: "failed", result: "Stopped before it finished." });
});

test("a run's own stop ends its turn, while a person's Stop waits on the person", () => {
  const stoppedRoot = root({ attention: "stopped" });
  const children = CliTree.parse([]);
  expect(runTreeState({ root: stoppedRoot, windowWork: "none", children, cancelling: true })).toBe(
    "failed",
  );
  expect(runTreeState({ root: stoppedRoot, windowWork: "none", children, cancelling: false })).toBe(
    "needs-human",
  );
  // Killed work never carries on, whoever stopped it.
  expect(
    runTreeState({
      root: { ...stoppedRoot, cancelled: true },
      windowWork: "none",
      children,
      cancelling: false,
    }),
  ).toBe("failed");
});

test("a run whose delegated thread still works is not over, even after its root turn ended", () => {
  expect(
    runTreeState({
      root: root(),
      windowWork: "none",
      children: child("working"),
      cancelling: true,
    }),
  ).toBe("working");
  expect(
    runTreeState({
      root: root(),
      windowWork: "none",
      children: child("done", true),
      cancelling: true,
    }),
  ).toBe("failed");
});

test("a later turn in the thread neither holds the run open nor counts as its work", () => {
  // Once another turn started, the thread's own state is that turn's: only the run's work counts.
  expect(
    runTreeState({
      root: undefined,
      windowWork: "none",
      children: CliTree.parse([]),
      cancelling: false,
    }),
  ).toBe("ok");
  expect(
    runTreeState({
      root: undefined,
      windowWork: "working",
      children: CliTree.parse([]),
      cancelling: false,
    }),
  ).toBe("working");
  expect(
    runTreeState({
      root: undefined,
      windowWork: "needs-human",
      children: CliTree.parse([]),
      cancelling: false,
    }),
  ).toBe("needs-human");
  // Messages others queued, held behind the thread's own queue, are not the run's work.
  expect(
    runTreeState({
      root: root({ status: { state: "waiting", on: "queue" } }),
      windowWork: "none",
      children: CliTree.parse([]),
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
  liveChildren: [],
  ...patch,
});

test("stopping a run never interrupts a turn that is not its own", () => {
  const someoneElse = { runId: "run-other", ours: false };
  expect(stopPlan(stopFacts({ rootActive: someoneElse }))).toEqual({ kind: "none" });
  expect(
    stopPlan(
      stopFacts({ fate: { state: "sending" }, boundRun: undefined, rootActive: someoneElse }),
    ),
  ).toEqual({ kind: "wait" });
  expect(
    stopPlan(
      stopFacts({ fate: { state: "delivered" }, boundRun: undefined, rootActive: someoneElse }),
    ),
  ).toEqual({ kind: "wait" });
  expect(stopPlan(stopFacts({ rootActive: { runId: "run-own-later", ours: true } }))).toEqual({
    kind: "interrupt",
    runId: "run-own-later",
  });
});

test("stopping a run takes a queued message out, and after its turn stops only its children", () => {
  expect(stopPlan(stopFacts({ fate: { state: "waiting" }, boundRun: undefined }))).toEqual({
    kind: "remove",
  });
  expect(stopPlan(stopFacts({ fate: { state: "sending" }, boundRun: undefined }))).toEqual({
    kind: "interrupt",
  });
  const children = [ThreadId.parse("child")];
  expect(stopPlan(stopFacts({ liveChildren: children }))).toEqual({
    kind: "cancel-children",
    children,
  });
  expect(stopPlan(stopFacts({ fate: { state: "removed" }, boundRun: undefined }))).toEqual({
    kind: "none",
  });
});
