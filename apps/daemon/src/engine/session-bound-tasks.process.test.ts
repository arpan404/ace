import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
import { createEngineThread } from "./create-thread.ts";
import { AdapterRegistry } from "./registry.ts";
import { EngineRepository } from "./repository.ts";
import { harness, ManualClock, scriptFrames, start, end } from "./test-support.ts";

const placeholder: Fact = {
  type: "background.started",
  agent: "root",
  task: "claude:s:p1:unbound:toolu_1",
  kind: "subagent",
  title: "Subagent",
  stoppable: false,
};
const overflow: Fact = {
  type: "background.started",
  agent: "root",
  task: "claude:s:p1:unbound:overflow",
  kind: "other",
  title: "Unregistered subagent transcripts",
  internal: true,
  stoppable: false,
};
const subagent: Fact = {
  type: "background.started",
  agent: "root",
  task: "claude:s:p1:task:a1",
  kind: "subagent",
  title: "Fix stale lease",
  stoppable: true,
};
const shell: Fact = {
  type: "background.started",
  agent: "root",
  task: "claude:s:p1:task:b1",
  kind: "shell",
  title: "bun run dev",
  stoppable: true,
};
const statuses = (store: Store, id: ThreadId) =>
  Object.fromEntries(
    Object.values(store.snapshotThread(id).backgroundTasks).map((task) => [
      task.title,
      task.status,
    ]),
  );

test("a Claude child placeholder left by a previous daemon run stops holding its thread after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "session-bound-"));
  const path = join(home, "state.sqlite");
  const id = ThreadId.parse("stale-placeholder-thread");
  try {
    const before = new Store(path);
    const repo = new EngineRepository(before);
    createEngineThread(repo, {
      id,
      workspaceId: before.createWorkspace(home, "Fixture"),
      title: "Subagents",
      selection: { provider: "claude", options: {} },
      cwd: home,
      at: 1,
      silenceMs: 100,
    });
    // An older daemon saw the provider exit and kept every unfinished task as lost.
    repo.apply(
      id,
      [
        { type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" },
        placeholder,
        overflow,
        subagent,
        shell,
        { type: "turn.ended", agent: "root", outcome: "completed" },
        { type: "process.exited", deliberate: true },
      ],
      2,
    );
    expect(Object.values(statuses(before, id))).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
    await before.close();

    const store = new Store(path);
    const engine = new Engine(store, { registry: new AdapterRegistry(), clock: new ManualClock() });
    try {
      await engine.flush();
      expect(statuses(store, id)).toEqual({
        Subagent: "stopped",
        "Unregistered subagent transcripts": "stopped",
        "Fix stale lease": "stopped",
        // A background shell may outlive the CLI: ace still reports it as possibly running.
        "bun run dev": "unknown",
      });
      const placeholderTask = Object.values(store.snapshotThread(id).backgroundTasks).find(
        (task) => task.title === "Subagent",
      );
      expect(placeholderTask?.endedAt).toBe(2);
    } finally {
      await engine.close();
      await store.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a Claude session that exits settles the child work that lived inside it", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [frames.frame(start, placeholder, subagent, shell, end)],
        exit: { deliberate: false, message: "killed" },
      },
    ],
    frames,
    { provider: "claude" },
  );
  try {
    const id = await h.create();
    await h.engine.flush();
    expect(statuses(h.store, id)).toEqual({
      Subagent: "stopped",
      "Fix stale lease": "stopped",
      "bun run dev": "unknown",
    });
  } finally {
    await h.close();
  }
});
