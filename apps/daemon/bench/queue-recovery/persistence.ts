import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createThreadState, apply } from "@ace/core";
import { Thread, ThreadId, type EventPayload } from "@ace/protocol";
import { Store } from "@ace/daemon";
import { ContextMeters } from "../../src/engine/context-meter.ts";
const root = mkdtempSync(join(tmpdir(), "ace-context-bench-")),
  store = new Store(join(root, "events.sqlite"));
try {
  const threadId = ThreadId.parse("bench"),
    workspaceId = store.createWorkspace(root, "Bench", 1000);
  store.appendEvents(
    threadId,
    [
      {
        type: "thread.created",
        thread: Thread.parse({
          id: threadId,
          workspaceId,
          provider: "codex",
          title: "Bench",
          status: { state: "new" },
          createdAt: 1000,
          updatedAt: 1000,
        }),
      },
    ],
    1000,
  );
  const state = createThreadState({ threadId, config: { provider: "codex", silenceMs: 1000 } });
  const events = apply(
    state,
    {
      type: "agent.seen",
      agent: "root",
      origin: "root",
      fidelity: "full",
      cwd: root,
      native: { provider: "codex" },
    },
    { now: 1000, ids: { next: () => "root" } },
  );
  store.appendEvents(threadId, events, 1000);
  const meters = new ContextMeters(store, () => 128000),
    iterations = 10000,
    started = performance.now();
  for (let i = 0; i < iterations; i++) {
    const facts: EventPayload[] = apply(
      state,
      { type: "context.sample", agent: "root", usedTokens: i, sessionId: "native", model: "model" },
      { now: 1000, ids: { next: () => "root" } },
    );
    store.atomic(() => meters.observe(state, facts, 1000));
  }
  const elapsed = performance.now() - started;
  console.log(
    `SQLite context projection: ${Math.round((iterations * 1000) / elapsed)} ops/s, ${((elapsed * 1000) / iterations).toFixed(2)} us/op`,
  );
  console.log(`Peak RSS: ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB`);
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
