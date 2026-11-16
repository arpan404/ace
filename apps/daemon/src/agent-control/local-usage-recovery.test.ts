import { mkdtempSync, rmSync } from "node:fs";
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
  const store = new Store(join(home, "events.sqlite"), (error) => {
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
