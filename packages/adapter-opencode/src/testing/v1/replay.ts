import { apply, createThreadState, type Fact } from "@ace/core";
import { applyEvent, createThreadView } from "@ace/projection";
import { Event, Thread } from "@ace/protocol";
import type { Frame } from "@ace/engine-api";
import { OpenCodeTranslator } from "./translator.ts";
export function harness() {
  const thread = Thread.parse({
    id: "thread_fixture",
    workspaceId: "workspace_fixture",
    provider: "opencode",
    title: "test",
    status: { state: "new" },
    createdAt: 0,
    updatedAt: 0,
  });
  const state = createThreadState({
    threadId: thread.id,
    config: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
  });
  const translator = new OpenCodeTranslator({ threadId: state.threadId, rootKey: "root" });
  const view = createThreadView(thread);
  const diagnostics: import("@ace/protocol").RawPayload[] = [];
  let sequence = 0;
  let eventSequence = 0;
  const accept = (facts: Fact[], now: number) => {
    for (const fact of facts)
      for (const payload of apply(state, fact, {
        now,
        ids: { next: (kind) => `${kind}_${++sequence}` },
      }))
        applyEvent(
          view,
          Event.parse({
            id: `event_${++eventSequence}`,
            seq: eventSequence,
            at: now,
            threadId: thread.id,
            payload,
          }),
        );
  };
  return {
    view,
    diagnostics,
    translator,
    feed(frame: Frame) {
      accept(translator.translate(frame, frame.t), frame.t);
      diagnostics.push(...translator.takeDiagnostics());
    },
    tick(now: number) {
      accept([...translator.tick(now), { type: "tick" }], now);
    },
  };
}
