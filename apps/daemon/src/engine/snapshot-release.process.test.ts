import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadId } from "@ace/protocol";
import { Store } from "../store.ts";
import { EngineRepository } from "./repository.ts";
import { createEngineThread } from "./create-thread.ts";

const turn = (nativeTurnId: string) =>
  [
    { type: "turn.started", agent: "root", nativeTurnId, trigger: "user" },
    { type: "turn.ended", agent: "root", nativeTurnId, outcome: "completed" },
  ] as const;

test("a state kept after its snapshot is dropped reads native runs it first opens later as currently stored", async () => {
  const home = await mkdtemp(join(tmpdir(), "snapshot-release-"));
  const store = new Store(join(home, "state.sqlite"));
  try {
    const repo = new EngineRepository(store);
    const id = ThreadId.parse("release-thread");
    createEngineThread(repo, {
      id,
      workspaceId: store.createWorkspace(home, "Fixture"),
      title: "Release",
      selection: { provider: "claude", options: {} },
      cwd: home,
      at: 1,
      silenceMs: 100,
    });
    repo.apply(id, [...turn("native-1")], 2);
    repo.apply(id, [...turn("native-2")], 3);
    const current = repo.requireState(id).agents.root?.nativeRuns;
    const first = current?.["native-1"];
    const second = current?.["native-2"];
    if (!first || !second) throw new Error("Fixture turns have no native runs");

    // A newly loaded snapshot whose agent dictionaries nothing has opened yet.
    repo.evict(id);
    const kept = repo.requireState(id);
    repo.evict(id);
    // The kept state opens the agent's native runs only now, after its snapshot was released.
    expect(kept.agents.root?.nativeRuns?.["native-1"]).toBe(first);

    const fresh = repo.requireState(id);
    const runs = fresh.agents.root?.nativeRuns;
    if (!runs) throw new Error("Fresh state lost its native runs");
    runs["native-1"] = second;
    repo.save(fresh, [], 4);

    expect(kept.agents.root?.nativeRuns?.["native-1"]).toBe(second);
  } finally {
    await store.close();
    await rm(home, { recursive: true, force: true });
  }
});
