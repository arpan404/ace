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
      apply(state, fact, { now: seq, ids: { next: (kind) => `${kind}-${++id}` } });
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

test("an idle Cursor host exit does not claim that work became uncertain", () => {
  const threadId = ThreadId.parse("idle-exit");
  const translator = new CursorTranslator({ threadId, rootKey: "root" });
  const facts = translator.translate(
    {
      seq: 1,
      t: 1,
      dir: "note",
      channel: "sdk",
      data: {
        schemaVersion: 1,
        generation: "host",
        operationId: "open",
        segment: 0,
        kind: "host-exit",
        body: { deliberate: false },
      },
    },
    1,
  );
  expect(
    facts.filter((fact) => fact.type === "item.upsert" && fact.draft.type === "notice"),
  ).toEqual([]);
});
