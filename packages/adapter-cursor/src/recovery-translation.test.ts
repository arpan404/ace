import { apply, createThreadState, deriveThreadStatus } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { expect, test } from "vitest";
import { createCursorAdapter, type CursorEnvelope } from "./index.ts";

/** A Cursor thread fed host frames as the daemon commits them; `kind` frames go in order. */
function thread() {
  const threadId = ThreadId.parse("cursor-recovery");
  const translator = createCursorAdapter().createTranslator({ threadId, rootKey: "root" });
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
  let seq = 0;
  let id = 0;
  const frame = (
    kind: string,
    body: unknown,
    extra: Partial<CursorEnvelope> & { generation?: string } = {},
  ) => {
    const input: Frame = {
      seq: ++seq,
      t: seq,
      channel: "sdk",
      dir: kind === "send" ? "send" : "recv",
      data: {
        schemaVersion: 1,
        generation: "host1",
        operationId: "op",
        segment: 0,
        agentId: "agent",
        kind,
        body,
        ...extra,
      },
    };
    for (const fact of translator.translate(input, seq))
      apply(state, fact, { now: seq, ids: { next: (entity) => `${entity}-${++id}` } });
  };
  const items = () => Object.values(state.items);
  const text = (role: "user" | "assistant") =>
    items().flatMap((item) =>
      item.type === "message" && item.role === role
        ? [item.parts.map((part) => (part.type === "text" ? part.text : "")).join("")]
        : [],
    );
  const notices = () =>
    items().flatMap((item) => (item.type === "notice" ? [item.text ?? ""] : []));
  const status = () => deriveThreadStatus(state).state;
  const runs = () => Object.values(state.runs);
  return { frame, text, notices, status, runs };
}
const said = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

test("a send Cursor has not admitted yet shows working but starts no turn and shows no input", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "hello" }], attemptedAt: 1 });
  expect(t.runs()).toEqual([]);
  expect(t.text("user")).toEqual([]);
  expect(t.status()).toBe("working");
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  expect(t.runs()).toHaveLength(1);
  expect(t.text("user")).toEqual(["hello"]);
});

test("a send ace restarted before Cursor received it says so and leaves the thread idle", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "hello" }], attemptedAt: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "admission",
    { operationId: "op", segment: 0, admitted: false },
    { generation: "host2", operationId: "open" },
  );
  expect(t.runs()).toEqual([]);
  expect(t.status()).not.toBe("working");
  expect(t.notices().join(" ")).toContain("It was not sent");
});

test("a run that finished just before the daemon crashed shows as finished after restart", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "the whole answer" },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.runs().map((run) => run.state)).toEqual(["completed"]);
  expect(t.text("assistant")).toEqual(["the whole answer"]);
  expect(t.status()).toBe("done");
  expect(t.notices().join(" ")).toContain("finished this run while ace was restarting");
});

test("a cut-off run's missing tail is recovered and marked as recovered, and the turn is not done", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "live part" }, { runId: "run", streamSeq: 1 });
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame("recovered", said("missed "), after);
  t.frame("recovered", said("tail"), after);
  t.frame("recovered", { type: "tool_call", name: "shell", status: "completed" }, after);
  t.frame("recovery", { nativeStatus: "running", interrupted: true }, after);
  expect(t.text("assistant")).toEqual(["live part", "missed tail"]);
  const notice = t.notices().join(" ");
  expect(notice).toContain("recovered from Cursor's saved session");
  expect(notice).toContain("shell (completed)");
  expect(t.runs().map((run) => run.state)).toEqual(["failed"]);
  expect(t.status()).not.toBe("done");
});
