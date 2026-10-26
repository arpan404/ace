import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { ThreadId } from "@ace/protocol";
import { Store } from "../store.ts";
import { EngineRepository } from "../engine/repository.ts";
import { createEngineThread } from "../engine/create-thread.ts";

// Run in a fresh Node process: reports the heap still held after a thread's snapshot is
// dropped and reloaded many times, the way restarts, rollbacks and trims reload it in the daemon.
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const reloads = Number(process.argv[2] ?? 1500);

const home = await mkdtemp(join(tmpdir(), "snapshot-retention-"));
const store = new Store(join(home, "state.sqlite"));
try {
  const repo = new EngineRepository(store);
  const id = ThreadId.parse("retention-thread");
  createEngineThread(repo, {
    id,
    workspaceId: store.createWorkspace(home, "Fixture"),
    title: "Retention",
    selection: { provider: "claude", options: {} },
    cwd: home,
    at: 1,
    silenceMs: 100,
  });
  // A native turn id gives the root agent its own nativeRuns dictionary.
  repo.apply(
    id,
    [
      { type: "turn.started", agent: "root", nativeTurnId: "native-1", trigger: "user" },
      {
        type: "item.upsert",
        agent: "root",
        item: "message",
        draft: {
          type: "message",
          role: "assistant",
          parts: [{ type: "text", text: "done" }],
          complete: true,
        },
      },
      { type: "turn.ended", agent: "root", outcome: "completed" },
    ],
    2,
  );
  const reload = () => {
    repo.evict(id);
    const state = repo.requireState(id);
    if (!state.agents.root?.nativeRuns) throw new Error("Fixture agent lost its native runs");
  };
  for (let i = 0; i < 50; i++) reload();
  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < reloads; i++) reload();
  gc();
  gc();
  const after = process.memoryUsage().heapUsed;
  process.stdout.write(JSON.stringify({ reloads, retainedIncrease: after - before }));
} finally {
  await store.close();
  await rm(home, { recursive: true, force: true });
}
