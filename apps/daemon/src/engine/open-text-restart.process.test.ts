import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@ace/protocol";
import { Store } from "../store.ts";
import { EngineRepository } from "./repository.ts";
import { createEngineThread } from "./create-thread.ts";

async function thinkingThread() {
  const home = await mkdtemp(join(tmpdir(), "open-text-"));
  const path = join(home, "state.sqlite");
  const store = new Store(path);
  const id = ThreadId.parse("open-text-thread");
  const repo = new EngineRepository(store);
  createEngineThread(repo, {
    id,
    workspaceId: store.createWorkspace(home, "Fixture"),
    title: "Thinking",
    selection: { provider: "opencode", options: {} },
    cwd: home,
    at: 1,
    silenceMs: 100,
  });
  repo.apply(
    id,
    [
      { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
      { type: "item.delta", agent: "root", item: "thought", field: "reasoning", append: "Re" },
    ],
    2,
  );
  await store.close();
  return {
    id,
    path,
    async close() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function endAfterRestart(path: string, id: ThreadId) {
  const store = new Store(path);
  try {
    const state = new EngineRepository(store).apply(
      id,
      [{ type: "turn.ended", agent: "root", nativeTurnId: "t1", outcome: "interrupted" }],
      3,
    );
    // Detached from the store, which closes below.
    return {
      thought: structuredClone(state.items.thought),
      runs: Object.values(state.runs).map((run) => run.state),
    };
  } finally {
    await store.close();
  }
}

test("a thought still streaming when the daemon restarted closes when its turn ends", async () => {
  const h = await thinkingThread();
  try {
    const { thought, runs } = await endAfterRestart(h.path, h.id);
    expect(runs).toEqual(["interrupted"]);
    expect(thought).toMatchObject({ type: "reasoning", text: "Re", complete: true });
  } finally {
    await h.close();
  }
});

test("a thread saved before open text was tracked still loads and ends its turn", async () => {
  const h = await thinkingThread();
  try {
    const store = new Store(h.path);
    store.atomic((db) => {
      db.prepare(
        "UPDATE thread_state SET state=json_remove(state,'$.indexes.openText') WHERE thread_id=?",
      ).run(h.id);
      db.prepare("DELETE FROM engine_state_records WHERE thread_id=? AND section='openText'").run(
        h.id,
      );
    });
    await store.close();
    const { runs } = await endAfterRestart(h.path, h.id);
    expect(runs).toEqual(["interrupted"]);
  } finally {
    await h.close();
  }
});
