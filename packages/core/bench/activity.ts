import { ThreadId } from "@ace/protocol";
import { apply, createThreadState } from "../src/index.ts";

// Non-gating, real clock only measures calls; the engine still receives injected time.
for (const historySize of [0, 1_000, 5_000, 10_000]) {
  let id = 0;
  let now = 100;
  const ids = { next: (kind: string) => `${kind}_${++id}` };
  const state = createThreadState({
    threadId: ThreadId.parse("benchmark"),
    config: { provider: "codex", silenceMs: 90_000 },
  });
  apply(state, { type: "turn.started", agent: "root", trigger: "user" }, { now, ids });
  for (let index = 0; index < historySize; index++) {
    apply(
      state,
      {
        type: "item.upsert",
        agent: "root",
        item: `message_${index}`,
        draft: {
          type: "message",
          complete: true,
          parts: [{ type: "text", text: "Completed output" }],
        },
      },
      { now: ++now, ids },
    );
  }
  const started = performance.now();
  for (let index = 0; index < 1_000; index++) {
    apply(
      state,
      { type: "activity", agent: "root", activity: index % 2 === 0 ? "thinking" : "responding" },
      { now: ++now, ids },
    );
  }
  console.log(
    `${historySize} historical items: ${(performance.now() - started).toFixed(2)} ms / 1000 activity facts`,
  );
}
