// Replaced by @ace/adapter-testkit when the shared replay API lands.
import { readFileSync } from "node:fs";
import { apply, createThreadState, type Fact } from "@ace/core";
import { EventPayload, ThreadId } from "@ace/protocol";
import type { Frame } from "./contract.ts";
import { OpenCodeTranslator } from "./translator.ts";
export function harness() {
  const state = createThreadState({
    threadId: ThreadId.parse("thread_fixture"),
    config: { provider: "opencode", liveness: "transport", silenceMs: 25_000 },
  });
  const translator = new OpenCodeTranslator({ threadId: state.threadId, rootKey: "root" });
  let sequence = 0;
  const events: EventPayload[] = [];
  const accept = (facts: Fact[], now: number) => {
    for (const fact of facts)
      for (const event of apply(state, fact, {
        now,
        ids: { next: (kind) => `${kind}_${++sequence}` },
      }))
        events.push(EventPayload.parse(event));
  };
  return {
    state,
    events,
    translator,
    feed(frame: Frame) {
      accept(translator.translate(frame, frame.t), frame.t);
    },
    tick(now: number) {
      accept([...translator.tick(now), { type: "tick" }], now);
    },
  };
}
export function fixture(path: string) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line) as Frame);
}
