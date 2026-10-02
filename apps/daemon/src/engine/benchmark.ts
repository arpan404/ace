/** Non-gating benchmark for the full JSON snapshots required by ADR 0007. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createThreadState, type Fact } from "@ace/core";
import { Store } from "../store.ts";
import { createDevThread } from "../commands.ts";
import { EngineRepository } from "./repository.ts";

for (const history of [10, 100, 1000]) {
  const home = mkdtempSync(join(tmpdir(), "ace-engine-bench-"));
  const store = new Store(join(home, "events.sqlite"));
  try {
    const workspace = store.createWorkspace(home, "Benchmark");
    const thread = createDevThread(store, workspace);
    const repo = new EngineRepository(store);
    repo.save(
      createThreadState({
        threadId: thread.id,
        config: { provider: "codex", silenceMs: 60_000 },
        rootAgent: { agent: "root", fidelity: "full", native: { provider: "codex" }, cwd: home },
      }),
      [],
      1000,
    );
    const facts: Fact[] = [{ type: "turn.started", agent: "root", trigger: "user" }];
    for (let index = 0; index < history; index++)
      facts.push({
        type: "item.upsert",
        agent: "root",
        item: `item:${index}`,
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "a".repeat(100) }],
          complete: false,
        },
      });
    repo.apply(thread.id, facts, 1000);
    const iterations = 50;
    const began = performance.now();
    for (let index = 0; index < iterations; index++)
      repo.apply(
        thread.id,
        [{ type: "item.delta", agent: "root", item: "item:0", field: "text", append: "x" }],
        1001 + index,
      );
    const elapsed = performance.now() - began;
    const snapshotBytes = store.atomic((db) =>
      Number(
        db.prepare("SELECT length(CAST(state AS BLOB)) AS bytes FROM thread_state").get()?.bytes,
      ),
    );
    process.stdout.write(
      JSON.stringify({ history, iterations, snapshotBytes, meanApplyMs: elapsed / iterations }) +
        "\n",
    );
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
}
