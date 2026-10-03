import { apply, createThreadState, type Fact } from "@ace/core";
import { EventPayload, ThreadId, type EventPayload as Payload } from "@ace/protocol";
import { createCodexTranslator } from "./translator.ts";
import type { Frame } from "@ace/engine-api";
export function replayHarness() {
  const translator = createCodexTranslator({
    threadId: ThreadId.parse("fixture"),
    rootKey: "root",
  });
  const state = createThreadState({
    threadId: ThreadId.parse("fixture"),
    config: { provider: "codex", silenceMs: 90_000 },
  });
  let sequence = 0;
  const events: Payload[] = [];
  function feed(frame: Frame) {
    for (const fact of translator.translate(frame, frame.t)) feedFact(fact, frame.t);
  }
  function feedFact(fact: Fact, now: number) {
    for (const event of apply(state, fact, {
      now,
      ids: { next: (kind) => `${kind}_${++sequence}` },
    })) {
      EventPayload.parse(event);
      events.push(structuredClone(event));
      if (
        (event.type === "item.created" || event.type === "item.updated") &&
        event.item.type === "notice" &&
        event.item.raw.some((r) => r.type === "core.rejected_fact")
      )
        throw new Error(event.item.text);
    }
  }
  return { translator, state, events, feed, feedFact };
}
