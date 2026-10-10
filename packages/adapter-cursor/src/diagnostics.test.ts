import { expect, test } from "vitest";
import { apply, createThreadState, deriveThreadStatus } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { CursorTranslator } from "./index.ts";

test("routine Cursor operations retain raw diagnostics without transcript notices", () => {
  const threadId = ThreadId.parse("diagnostics");
  const translator = new CursorTranslator({ threadId, rootKey: "root" });
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
  let seq = 0,
    id = 0;
  const native = [
    { kind: "open", body: { cwd: "/synthetic", sandboxSupported: false } },
    { kind: "send", body: { input: [{ type: "text", text: "user question" }] } },
    { kind: "segment", body: { nativeRunId: "run-27c3cb35" } },
    { kind: "observe", body: { nativeFutureField: "retained" } },
    { kind: "delta", body: { type: "text-delta", text: "answer" } },
    { kind: "result", body: { status: "finished" } },
  ];
  for (const entry of native) {
    const data = {
      schemaVersion: 1,
      generation: "host",
      operationId: "operation-uuid",
      segment: 0,
      ...entry,
    };
    for (const fact of translator.translate(
      { seq: ++seq, t: seq, dir: "recv", channel: "sdk", data },
      seq,
    ))
      apply(state, fact, { now: seq, ids: { next: (entity) => `${entity}-${++id}` } });
    const diagnostics = translator.takeDiagnostics?.() ?? [];
    expect(
      diagnostics.some((raw) => "data" in raw && JSON.stringify(raw.data) === JSON.stringify(data)),
    ).toBe(true);
    expect(translator.takeDiagnostics?.()).toEqual([]);
  }
  expect(Object.values(state.items).filter((item) => item.type === "notice")).toEqual([]);
  expect(
    Object.values(state.items)
      .filter((item) => item.type === "message")
      .map((item) => (item.type === "message" ? item.parts : [])),
  ).toEqual([[{ type: "text", text: "user question" }], [{ type: "text", text: "answer" }]]);
  expect(deriveThreadStatus(state).state).toBe("done");
});

// Canonical visibility, rather than English-string filtering, owns these display decisions.
import { isRawHistoryItem } from "@ace/projection";
import { replay } from "./translator-test-support.ts";

test("every Cursor bookkeeping frame is retained without becoming visible conversation", () => {
  const r = replay();
  r.frame("snapshot", { items: [{ uuid: "positional:0", text: "untrusted snapshot" }] });
  r.frame("message", { type: "task" });
  r.frame("delta", {
    type: "tool-call-delta",
    callId: "missing",
    taskUpdate: { type: "text-delta", text: "unowned" },
  });
  r.frame("delta", { type: "shell-output-delta", text: "unassociated output" });
  r.frame("shell-output", { parentCallId: "missing", text: "unowned shell" });
  const notices = Object.values(r.state.items).filter((item) => item.type === "notice");
  expect(notices).toHaveLength(5);
  expect(notices.every(isRawHistoryItem)).toBe(true);
  expect(JSON.stringify(notices)).toContain("unassociated output");
});

test("a quiet host exit does not warn but an active run does", () => {
  const quiet = replay();
  quiet.frame("result", { status: "finished" });
  quiet.frame("host-exit", { deliberate: false });
  expect(Object.values(quiet.state.items).filter((item) => item.type === "notice")).toEqual([]);
  const active = replay();
  active.frame("host-exit", { deliberate: false });
  expect(
    Object.values(active.state.items).filter(
      (item) => item.type === "notice" && !isRawHistoryItem(item),
    ),
  ).toHaveLength(1);
});

test("two diagnostics from one frame retain separate evidence without either overwriting the other", () => {
  const threadId = ThreadId.parse("same-frame");
  const translator = new CursorTranslator({ threadId, rootKey: "root" });
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
  let id = 0;
  for (const [seq, kind, body] of [
    [1, "open", { cwd: "/synthetic" }],
    [2, "send", { input: [] }],
    [
      3,
      "delta",
      {
        type: "tool-call-started",
        callId: "tool",
        toolCall: {
          type: "mcp",
          args: { server: "docs", tool: "lookup" },
          truncated: { args: true },
        },
      },
    ],
  ] as const) {
    for (const fact of translator.translate(
      {
        seq,
        t: seq,
        dir: "recv",
        channel: "sdk",
        data: {
          schemaVersion: 1,
          generation: "host",
          operationId: "op",
          segment: 0,
          kind,
          body,
          raw: { type: "cursor.sdk.v1", data: { evidence: "retained" } },
        },
      },
      seq,
    ))
      apply(state, fact, { now: seq, ids: { next: (entity) => `${entity}-${++id}` } });
  }
  const notices = Object.values(state.items).filter((item) => item.type === "notice");
  expect(notices).toHaveLength(2);
  expect(notices.map((item) => item.text).join("\n")).toContain("semantic preview");
  expect(notices.map((item) => item.text).join("\n")).toContain("truncated by the SDK");
  expect(notices.every(isRawHistoryItem)).toBe(true);
});

test("host exit warns while a background child survives a settled root turn", () => {
  const r = replay();
  r.frame("delta", {
    type: "tool-call-started",
    callId: "child",
    toolCall: { type: "task", args: { description: "Background review" } },
  });
  r.frame("delta", {
    type: "tool-call-completed",
    callId: "child",
    toolCall: {
      type: "task",
      result: { status: "success", value: { agentId: "native-child", isBackground: true } },
    },
  });
  r.frame("result", { status: "finished" });
  r.frame("host-exit", { deliberate: false });
  expect(deriveThreadStatus(r.state).state).not.toBe("done");
  expect(
    Object.values(r.state.items).filter(
      (item) => item.type === "notice" && !isRawHistoryItem(item),
    ),
  ).toHaveLength(1);
});
