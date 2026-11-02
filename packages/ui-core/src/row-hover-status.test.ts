import { BackgroundTaskId, type ThreadRunMetadata, type ThreadStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { threadLiveFact } from "./live-status.ts";
import { rowAttention, type RowAttentionInput } from "./row-attention.ts";
import { hoverStatusLine } from "./row-hover-status.ts";
import type { Tone } from "./status.ts";

/** The hover line for a row in a given state, its live facts read as the thread list has them. */
function line(
  row: Pick<RowAttentionInput, "tone" | "word"> & Partial<RowAttentionInput>,
  label: string,
  listed?: { status: ThreadStatus; live?: ThreadRunMetadata },
  waitingOn?: number,
) {
  const tone: Tone = row.tone;
  return hoverStatusLine({
    attention: rowAttention({ unread: false, settled: false, ...row }),
    card: { status: { label, tone, waitingOn } },
    fact: listed && threadLiveFact(listed),
  });
}

test("an approval reads Waiting for approval, in the warning colour", () => {
  const asks = line({ tone: "needs-you", word: "Approve" }, "Waiting for your approval");
  expect(asks).toEqual({ sentence: "Waiting for approval", detail: undefined, ink: "warning" });
});

test("a question reads Has a question", () => {
  const asks = line({ tone: "needs-you", word: "Answer" }, "Waiting for your answer");
  expect(asks.sentence).toBe("Has a question");
  expect(asks.ink).toBe("warning");
});

test("a thread with no model asks the person to choose one", () => {
  const model = line(
    { tone: "failed", word: "Pick a model", recovery: true, unread: true },
    "Pick a model",
  );
  expect(model.sentence).toBe("Choose a model to start");
  expect(model.ink).toBe("warning");
});

test("a fresh failure reads Failed in red, with its reason when the status has one", () => {
  expect(line({ tone: "failed", word: "Failed", unread: true }, "Failed")).toEqual({
    sentence: "Failed",
    detail: undefined,
    ink: "destructive",
  });
  expect(line({ tone: "failed", word: "Unresponsive", unread: true }, "Unresponsive")).toEqual({
    sentence: "Failed",
    detail: { text: "Unresponsive", code: false },
    ink: "destructive",
  });
});

test("a failure already seen reads Failed without colour", () => {
  expect(line({ tone: "failed", word: "Failed" }, "Failed")).toMatchObject({
    sentence: "Failed",
    ink: "muted",
  });
});

test("working names the step it is on when the list knows it", () => {
  const plain = line({ tone: "working", word: "Working" }, "Working", {
    status: { state: "working", agents: 1 },
  });
  expect(plain).toEqual({ sentence: "Working", detail: undefined, ink: "muted" });
  const tests = line({ tone: "working", word: "Working" }, "Working", {
    status: { state: "working", agents: 1 },
    live: { step: "tests" },
  });
  expect(tests.detail).toEqual({ text: "Running tests", code: false });
});

test("a thread waiting on its children counts them", () => {
  const waits = line(
    { tone: "waiting", word: "Waiting" },
    "Waiting for 2 subagents",
    { status: { state: "working", agents: 3 }, live: { waitingOn: 2 } },
    2,
  );
  expect(waits).toEqual({ sentence: "Waiting on 2 agents", detail: undefined, ink: "muted" });
});

test("background work names its one command as code", () => {
  const watching = line({ tone: "background", word: "Background" }, "Running in background", {
    status: { state: "waiting", on: "background_task" },
    live: { watching: [{ id: BackgroundTaskId.parse("task-1"), title: "bun run dev:relay" }] },
  });
  expect(watching).toEqual({
    sentence: "Running in background",
    detail: { text: "bun run dev:relay", code: true },
    ink: "muted",
  });
});

test("finished work not yet seen reads Finished; a thread at rest says nothing", () => {
  expect(line({ tone: "done", word: "Done", unread: true }, "Done").sentence).toBe("Finished");
  expect(line({ tone: "done", word: "Done" }, "Done").sentence).toBeUndefined();
});
