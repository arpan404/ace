import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { createDevThread } from "../commands.ts";
import { Store } from "../store.ts";
import { DelegationJournal } from "./journal.ts";
import { recoverLocalUsage } from "./local-usage-recovery.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A delegation tree whose child's usage events were committed with no subscriber running. */
function tree() {
  const home = mkdtempSync(join(tmpdir(), "ace-usage-recovery-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  const store = new Store(path, (error) => {
    throw error;
  });
  cleanup.push(() => void store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const root = createDevThread(store, workspace).id;
  const child = createDevThread(store, workspace).id;
  const journal = new DelegationJournal(store);
  store.atomic(() => {
    journal.tree(root, 1);
    journal.enroll(child, root);
  });
  const agentId = AgentId.parse("worker");
  return {
    usage(inputTokens: number) {
      store.appendEvents(child, [{ type: "usage.updated", agentId, inputTokens, outputTokens: 0 }]);
    },
    chatter() {
      store.appendEvents(child, [
        { type: "thread.client.updated", changes: { pinned: true } },
        { type: "thread.client.updated", changes: { pinned: false } },
      ]);
    },
    /**
     * Turns the child's chatter already on disk into usage samples, through a second SQLite
     * connection. A start that reads history again would count them; one that keeps to its
     * replay position never sees them. SQLite shows no per-statement scan counts here (no
     * `sqlite_stmt`, no step counters in node:sqlite), and the chatter rows never leave the
     * query either way, so this is how a rescan of old history becomes visible.
     */
    rewriteChatterAsUsage(inputTokens: number) {
      const db = new DatabaseSync(path);
      try {
        db.prepare(
          "UPDATE events SET type='usage.updated', payload=? WHERE thread_id=? AND type='thread.client.updated'",
        ).run(
          JSON.stringify({ type: "usage.updated", agentId, inputTokens, outputTokens: 0 }),
          child,
        );
      } finally {
        db.close();
      }
    },
    /** A restart: a fresh journal over the same database, recovering before work is admitted. */
    restart() {
      const restarted = new DelegationJournal(store);
      recoverLocalUsage(store, restarted);
      return restarted.tree(root, 1).usage.tokens;
    },
  };
}

test("usage written while no subscriber ran is counted on restart", () => {
  const world = tree();
  world.usage(5);
  world.chatter();
  expect(world.restart()).toBe(5);
});

test("restarting again counts nothing twice, even past events that carry no usage", () => {
  const world = tree();
  world.usage(5);
  world.chatter();
  world.restart();
  expect(world.restart()).toBe(5);
  world.chatter();
  expect(world.restart()).toBe(5);
});

test("usage written after a restart moved past chatter is still counted", () => {
  const world = tree();
  world.chatter();
  expect(world.restart()).toBe(0);
  world.usage(7);
  world.chatter();
  expect(world.restart()).toBe(7);
  // Samples are running totals for the agent's run.
  world.usage(10);
  expect(world.restart()).toBe(10);
});

test("a restart does not read again the history the last start went through, yet finds new usage", () => {
  const world = tree();
  world.chatter();
  expect(world.restart()).toBe(0);
  world.rewriteChatterAsUsage(100);
  world.usage(7);
  expect(world.restart()).toBe(7);
});
