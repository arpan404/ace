import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentId, type DelegationRecord, type ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { createDevThread } from "../commands.ts";
import { Store } from "../store.ts";
import { DelegationJournal } from "./journal.ts";
import { LimitNotices } from "./limit-notices.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A running delegated child held by a usage limit that ace resumes by itself at reset. */
function heldChild(parentGone: "deleted" | "live") {
  const home = mkdtempSync(join(tmpdir(), "ace-limit-notices-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"), (error) => {
    throw error;
  });
  cleanup.push(() => void store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  const parent = createDevThread(store, workspace).id;
  const child = createDevThread(store, workspace).id;
  const journal = new DelegationJournal(store);
  const record: DelegationRecord = {
    childId: child,
    parentId: parent,
    parentAgentId: AgentId.parse("root"),
    rootId: parent,
    requestId: "request-1",
    request: {
      requestId: "request-1",
      task: "work",
      role: "worker",
      provider: "claude",
      wait: false,
      estimatedLoad: 0,
    },
    depth: 1,
    createdAt: 1,
    phase: "running",
    generation: 0,
  };
  store.atomic((db) => {
    journal.tree(parent, 1);
    journal.enroll(child, parent);
    db.prepare(
      "INSERT INTO delegated_threads(child_id,parent_id,root_id,request_id,record,phase) VALUES (?,?,?,?,?,?)",
    ).run(child, parent, parent, record.requestId, JSON.stringify(record), record.phase);
  });
  store.appendEvents(child, [
    { type: "thread.updated", status: { state: "limited", until: 5_000 } },
    { type: "queue.updated", revision: 1, paused: true, reason: "limit", resumeAt: 5_000 },
  ]);
  if (parentGone === "deleted")
    store.appendEvents(parent, [{ type: "thread.client.updated", changes: { deletedAt: 2 } }]);
  const sends: ThreadId[] = [];
  let retries = 0;
  const notices = new LimitNotices({
    store,
    journal,
    now: () => 3,
    resuming: () => false,
    endedOnLimit: () => true,
    watching: () => false,
    sent: () => false,
    send(target) {
      sends.push(target);
      // What the engine says for a thread whose state was purged with it.
      if (parentGone === "deleted") throw new Error("Missing engine state");
    },
    retrying: () => retries++,
    closed: () => false,
    report() {},
  });
  return { notices, journal, child, parent, sends, retries: () => retries };
}

test("a held child whose parent was deleted tells no one and schedules no retry", () => {
  const world = heldChild("deleted");
  const edge = world.journal.get(world.child);
  if (!edge) throw new Error("edge missing");
  world.notices.check(edge);
  expect(world.sends).toEqual([]);
  expect(world.notices.retrying).toBe(false);
  expect(world.retries()).toBe(0);
});

test("a held child with a live parent tells it once", () => {
  const world = heldChild("live");
  const edge = world.journal.get(world.child);
  if (!edge) throw new Error("edge missing");
  world.notices.check(edge);
  expect(world.sends).toEqual([world.parent]);
  expect(world.journal.get(world.child)?.limitNotice).toMatchObject({ count: 1, held: true });
  expect(world.notices.retrying).toBe(false);
});
