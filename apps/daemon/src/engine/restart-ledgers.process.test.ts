import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId } from "@ace/protocol";
import { Store } from "@ace/daemon";
import { createEngineThread } from "./create-thread.ts";
import { EngineRepository } from "./repository.ts";

async function withThread(
  run: (path: string, id: ThreadId, home: string) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "restart-ledgers-"));
  try {
    await run(join(home, "state.sqlite"), ThreadId.parse("restart-ledger-thread"), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("an agent mid-run when the daemon stopped still holds its thread live after restart", async () => {
  await withThread(async (path, id, home) => {
    const before = new Store(path);
    const repo = new EngineRepository(before);
    createEngineThread(repo, {
      id,
      workspaceId: before.createWorkspace(home, "Fixture"),
      title: "Mid-run",
      selection: { provider: "codex", options: {} },
      cwd: home,
      at: 1,
      silenceMs: 100,
    });
    repo.apply(
      id,
      [{ type: "turn.started", agent: "root", nativeTurnId: "t1", trigger: "user" }],
      2,
    );
    await before.close();

    const store = new Store(path);
    try {
      const restarted = new EngineRepository(store);
      expect(restarted.quiescent(restarted.requireState(id))).toBe(false);
      restarted.apply(id, [{ type: "turn.ended", agent: "root", outcome: "completed" }], 3);
      expect(restarted.quiescent(restarted.requireState(id))).toBe(true);
    } finally {
      await store.close();
    }
  });
});

test("an approval answered before the request ledger existed is still known as answered after restart", async () => {
  await withThread(async (path, id, home) => {
    const before = new Store(path);
    const repo = new EngineRepository(before);
    createEngineThread(repo, {
      id,
      workspaceId: before.createWorkspace(home, "Fixture"),
      title: "Answered",
      selection: { provider: "codex", options: {} },
      cwd: home,
      at: 1,
      silenceMs: 100,
    });
    repo.nativeSession(id, "native-1");
    // An older daemon kept the outcome only in the thread's stored records.
    before.atomic((db) => {
      const record = db.prepare("INSERT INTO engine_state_records VALUES (?,?,?,?)");
      record.run(id, "items", "tool-item", JSON.stringify({ id: "call-1" }));
      record.run(
        id,
        "interactionHistory",
        "native-approval",
        JSON.stringify({ id: "approval-1", state: "resolved", toolCallId: "call-1" }),
      );
      db.prepare("DELETE FROM engine_interaction_requests WHERE thread_id=?").run(id);
    });
    await before.close();

    const store = new Store(path);
    try {
      const restarted = new EngineRepository(store);
      expect(restarted.interactions.outcome(id, "approval-1")).toBe("resolved");
      expect(restarted.interactions.terminalItem(id, "tool-item")).toBe(true);
    } finally {
      await store.close();
    }
  });
});
