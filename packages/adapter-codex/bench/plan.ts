// Non-gating measurement of the markdown upserts required by the current Fact API.
import { readFixture } from "@ace/adapter-testkit";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { createCodexTranslator } from "../src/index.ts";
const fixture = await readFixture(
  new URL("../../../fixtures/codex/0.159.1/plan-review.jsonl", import.meta.url).pathname,
);
const threadId = ThreadId.parse("benchmark");
const translator = createCodexTranslator({ threadId, rootKey: "root" });
const state = createThreadState({ threadId, config: { provider: "codex", silenceMs: 90_000 } });
let id = 0;
let planUpserts = 0;
let markdownBytes = 0;
const started = performance.now();
for (const frame of fixture.frames) {
  for (const fact of translator.translate(frame, frame.t)) {
    if (
      fact.type === "item.upsert" &&
      fact.draft.type === "tool_call" &&
      fact.draft.call?.detail?.kind === "plan"
    ) {
      planUpserts++;
      markdownBytes += Buffer.byteLength(fact.draft.call.detail.markdown ?? "");
    }
    apply(state, fact, { now: frame.t, ids: { next: (kind) => `${kind}-${++id}` } });
  }
}
process.stdout.write(
  JSON.stringify({
    milliseconds: performance.now() - started,
    planUpserts,
    markdownBytes,
    thread: state.status.state,
  }) + "\n",
);
