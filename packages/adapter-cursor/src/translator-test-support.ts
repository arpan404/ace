import { apply, createThreadState } from "@ace/core";
import { ThreadId, type EventPayload } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { createCursorAdapter, type CursorEnvelope } from "./index.ts";

export function replay(limits: { maxPendingBytes?: number } = {}) {
  let seq = 0;
  let id = 0;
  const threadId = ThreadId.parse("cursor-test");
  const translator = createCursorAdapter({ limits }).createTranslator({
    threadId,
    rootKey: "root",
  });
  const state = createThreadState({ threadId, config: { provider: "cursor", silenceMs: 90000 } });
  const events: EventPayload[] = [];
  const frame = (
    kind: CursorEnvelope["kind"],
    body: unknown,
    options: { segment?: number; operationId?: string; dir?: Frame["dir"] } = {},
  ) => {
    const input: Frame = {
      seq: ++seq,
      t: seq,
      channel: "sdk",
      dir: options.dir ?? "recv",
      data: {
        schemaVersion: 1,
        generation: "host1",
        operationId: options.operationId ?? "operation1",
        segment: options.segment ?? 0,
        agentId: "native-root",
        kind,
        body,
      },
    };
    for (const fact of translator.translate(input, seq))
      events.push(
        ...apply(state, fact, { now: seq, ids: { next: (entityKind) => `${entityKind}-${++id}` } }),
      );
    return input;
  };
  const repeat = (input: Frame) => {
    for (const fact of translator.translate(input, seq))
      events.push(
        ...apply(state, fact, { now: seq, ids: { next: (entityKind) => `${entityKind}-${++id}` } }),
      );
  };
  frame("open", { cwd: "/fixture", deltaSource: true });
  frame("send", { input: [{ type: "text", text: "synthetic input" }] });
  return { state, events, frame, repeat };
}
export function texts(state: ReturnType<typeof replay>["state"]) {
  return Object.values(state.items).flatMap((item) =>
    item.type === "message" && item.role === "assistant"
      ? [item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")]
      : [],
  );
}
