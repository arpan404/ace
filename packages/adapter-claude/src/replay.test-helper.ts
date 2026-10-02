// Replaced by adapter-testkit once the shared fixture runner is available.
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import type { Frame } from "./contract.ts";
import { createTranslator } from "./translator.ts";
export function replay(frames: Frame[]) {
  let sequence = 0;
  const state = createThreadState({
    threadId: ThreadId.parse("fixture"),
    config: { provider: "claude", silenceMs: 60_000 },
  });
  const translator = createTranslator({ rootKey: "root" });
  const ids = { next: (kind: string) => `${kind}_${++sequence}` };
  const timeline: { t: number; thread: string }[] = [];
  const events = [];
  for (const frame of frames) {
    for (const fact of translator.translate(frame, frame.t))
      events.push(...apply(state, fact, { now: frame.t, ids }));
    timeline.push({ t: frame.t, thread: state.status.state });
  }
  return { state, timeline, events };
}
