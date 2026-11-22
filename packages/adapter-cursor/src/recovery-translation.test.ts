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

test("a send Cursor's store has no run for leaves the thread idle and claims nothing of its fate", () => {
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
  // Whether it was sent is the daemon's to say, once it knows the read was final.
  expect(t.notices().join(" ")).not.toMatch(/not sent/i);
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
  t.frame("delta", { type: "text-delta", text: "live part " }, { runId: "run", eventSeq: 1 });
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame("recovered", said("missed "), after);
  t.frame("recovered", said("tail"), after);
  t.frame(
    "recovered",
    {
      type: "tool_call",
      call_id: "x",
      name: "shell",
      status: "completed",
      args: { command: "ls" },
      result: { status: "success", value: { exitCode: 0, stdout: "a", stderr: "" } },
      truncated: { result: true },
    },
    after,
  );
  t.frame("recovery", { nativeStatus: "running", interrupted: true }, after);
  // The answer the live stream started continues: one message, not a second copy.
  expect(t.text("assistant")).toEqual(["live part missed tail"]);
  const notice = t.notices().join(" ");
  expect(notice).toContain("recovered from Cursor's saved session");
  // The one thing the store can't give back is named, once.
  expect(t.notices().filter((text) => text.includes("shortened copy"))).toHaveLength(1);
  expect(t.runs().map((run) => run.state)).toEqual(["failed"]);
  expect(t.status()).not.toBe("done");
});

test("a finished turn whose last words never reached ace shows its whole answer from Cursor's result", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "The fix is " }, { runId: "run", eventSeq: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  // The SDK lost the rest of the stream's writes; its stored result has the whole answer.
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "The fix is in parser.ts." },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.text("assistant")).toEqual(["The fix is in parser.ts."]);
  expect(t.notices().join(" ")).toContain("Cursor's saved result");
  expect(t.status()).toBe("done");
});

test("a finished turn whose shown answer and stored result differ shows the result whole, said once", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "Draft" }, { runId: "run", eventSeq: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "Final answer." },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.text("assistant")).toEqual(["Draft", "Final answer."]);
  expect(t.notices().filter((text) => text.includes("Cursor's saved result"))).toHaveLength(1);
  expect(t.status()).toBe("done");
});

test("a finished turn whose answer ace showed whole repeats nothing from Cursor's result", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  t.frame("delta", { type: "text-delta", text: "All done." }, { runId: "run", eventSeq: 1 });
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, result: "All done." },
    { generation: "host2", operationId: "open", runId: "run" },
  );
  expect(t.text("assistant")).toEqual(["All done."]);
  expect(t.notices().join(" ")).not.toContain("Cursor's saved result");
  expect(t.status()).toBe("done");
});

test("a saved answer past the cap says once that it is cut, and the turn still ends done", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  t.frame("recovered-result", { text: "first part " }, after);
  t.frame("recovered-result", { text: "second part" }, after);
  t.frame(
    "recovery",
    { nativeStatus: "finished", interrupted: false, resultParts: 2, resultCut: true },
    after,
  );
  expect(t.text("assistant")).toEqual(["first part second part"]);
  expect(t.notices().filter((text) => text.includes("it is cut"))).toHaveLength(1);
  expect(t.status()).toBe("done");
});

test("a 3 MiB saved answer after 2 MiB of it streamed adds only the rest, never the streamed part again", () => {
  const t = thread();
  t.frame("open", { cwd: "/w" });
  t.frame("send", { input: [{ type: "text", text: "go" }] });
  t.frame("segment", { nativeRunId: "run" }, { runId: "run" });
  // Committed before the crash: 2 MiB in 64 KiB deltas, some of it multibyte.
  const chunk = `${"é".repeat(16 * 1024)}${"x".repeat(32 * 1024)}`;
  const streamed = chunk.repeat(32);
  for (let at = 0; at < streamed.length; at += chunk.length)
    t.frame("delta", { type: "text-delta", text: streamed.slice(at, at + chunk.length) });
  const rest = "y".repeat(1024 * 1024);
  const saved = streamed + rest;
  const after = { generation: "host2", operationId: "open", runId: "run" };
  t.frame("open", { cwd: "/w" }, { generation: "host2", operationId: "open" });
  let parts = 0;
  for (let at = 0; at < saved.length; at += 8_000, parts++)
    t.frame("recovered-result", { text: saved.slice(at, at + 8_000) }, after);
  t.frame("recovery", { nativeStatus: "finished", interrupted: false, resultParts: parts }, after);
  const shown = t.text("assistant").join("");
  expect(shown.length).toBe(saved.length);
  expect(shown).toBe(saved);
  expect(t.notices().join(" ")).toContain("The end of this answer is from Cursor's saved result");
  expect(t.status()).toBe("done");
});
