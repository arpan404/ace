import { expect, test } from "vitest";
import type { ThreadId } from "@ace/protocol";
import { setup } from "./test-support.ts";
import { end, start } from "../engine/test-support.ts";

/*
 * A parent thread deleted, then purged by storage cleanup, keeps its `threads` tombstone but has
 * no engine state. Its children's edges must never be reported to it: recovery that did so threw
 * "Missing engine state" at every start and took agent control down with it.
 */

type Harness = ReturnType<typeof setup>;

const stopsOnLimit = [
  { type: "retry", agent: "root", on: "rate_limit", until: 5000, message: "Quota exhausted" },
  { ...end, outcome: "failed", error: { kind: "quota", message: "Quota exhausted" } },
] as const;

/** The thread is deleted (tombstoned), as the person's delete or storage cleanup leaves it. */
async function markDeleted(h: Harness, id: ThreadId) {
  await h.engine.stopForDeletion(id);
  h.store.appendEvents(
    id,
    [{ type: "thread.client.updated", changes: { deletedAt: h.clock.now(), autoSettleAt: null } }],
    h.clock.now(),
  );
}

/** Storage cleanup removes the deleted thread's data, its engine state included. */
function purge(h: Harness, id: ThreadId) {
  h.store.atomic(() => h.store.purgeThreadData(id));
  h.engine.forgetPurged(id);
  expect(h.engine.hasState(id)).toBe(false);
}

const missingState = (h: Harness) =>
  h.errors.filter((error) => String(error).includes("Missing engine state"));

/** Agent control still serves a live thread: a new parent delegates and its child starts. */
async function delegatesAgain(h: Harness) {
  const other = await h.parent();
  const next = h.delegate(other, "after-recovery");
  await h.engine.flush();
  expect(h.service.journal.get(next.childId)?.phase).toBe("running");
}

test("agent control starts when a purged parent's settled child is still limited", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  await h.emit(child.childId, ...stopsOnLimit);
  expect(h.store.getThread(child.childId)?.status.state).toBe("limited");
  expect(h.service.journal.get(child.childId)?.phase).toBe("settled");

  h.engine.prepareDeletion(parent.threadId, "delete-parent");
  await markDeleted(h, parent.threadId);
  purge(h, parent.threadId);

  // Recovery reads the settled child again (revived: it is limited, not done).
  h.restartOwner();
  expect(h.service.journal.get(child.childId)).toMatchObject({ phase: "settled" });
  // The child's next run is never counted as work its gone parent waits on.
  await h.emit(child.childId, start);
  expect(h.service.journal.get(child.childId)).toMatchObject({ phase: "settled" });
  expect(missingState(h)).toEqual([]);
  await delegatesAgain(h);
});

test("an open child edge whose parent was purged while agent control was down settles as cancelled at the next start", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  expect(h.service.journal.get(child.childId)?.phase).toBe("running");

  // Agent control is down: nothing observes the deletion, so the edge stays open in the journal.
  h.service.close();
  await markDeleted(h, parent.threadId);
  purge(h, parent.threadId);
  expect(h.service.journal.active().map((edge) => edge.childId)).toEqual([child.childId]);

  h.restartOwner();
  expect(h.service.journal.get(child.childId)).toMatchObject({
    phase: "settled",
    outcome: { outcome: "cancelled" },
  });
  // The child's own thread is left as it was: still working, never shown done.
  expect(h.store.getThread(child.childId)?.status.state).toBe("working");
  // Nothing is owed to the parent that is gone, so no wake is left to retry.
  expect(h.service.journal.nextWake()).toBeUndefined();
  expect(missingState(h)).toEqual([]);
  await delegatesAgain(h);
});

test("deleting a parent settles its open child edges, so the child ending after the purge reports to nothing", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "review");
  await h.engine.flush();
  // The deletion policy cancels the child, but its provider has not stopped it yet.
  h.ignoreNextInterrupts(1);
  h.engine.prepareDeletion(parent.threadId, "delete-parent");
  expect(h.service.journal.get(child.childId)?.phase).toBe("cancelling");

  await markDeleted(h, parent.threadId);
  expect(h.service.journal.get(child.childId)).toMatchObject({
    phase: "settled",
    outcome: { outcome: "cancelled" },
  });
  expect(h.store.getThread(child.childId)?.status.state).toBe("working");

  purge(h, parent.threadId);
  await h.complete(child.childId, "Finished anyway.");
  expect(h.store.getThread(child.childId)?.status.state).toBe("done");
  expect(h.service.journal.nextWake()).toBeUndefined();
  h.restartOwner();
  expect(missingState(h)).toEqual([]);
  await delegatesAgain(h);
});

test("a child still queued for its parent's slot when the parent was purged is dropped from the queue at the next start", async () => {
  const h = setup({ maxConcurrent: 1 });
  const parent = await h.parent();
  h.delegate(parent, "running");
  await h.engine.flush();
  const queued = h.delegate(parent, "queued");
  await h.engine.flush();
  expect(h.service.journal.get(queued.childId)?.phase).toBe("created");

  h.service.close();
  await markDeleted(h, parent.threadId);
  purge(h, parent.threadId);
  const waiting = () =>
    h.store
      .statement("SELECT child_id FROM delegation_launch_queue WHERE parent_id=?")
      .all(parent.threadId);
  expect(waiting()).toHaveLength(1);

  h.restartOwner();
  expect(h.service.journal.get(queued.childId)).toMatchObject({
    phase: "settled",
    outcome: { outcome: "cancelled" },
  });
  expect(waiting()).toEqual([]);
  // The next pump never tries to start it for a parent that is gone.
  h.clock.advance(5000);
  await h.engine.flush();
  expect(missingState(h)).toEqual([]);
  await delegatesAgain(h);
});

test("the person can carry on a limited child of a deleted, purged middle thread on its own", async () => {
  const h = setup();
  const root = await h.parent();
  const middle = h.delegate(root, "middle");
  await h.engine.flush();
  const limited = h.delegate(h.caller(middle.childId), "limited");
  const running = h.delegate(h.caller(middle.childId), "running");
  await h.engine.flush();
  await h.emit(limited.childId, ...stopsOnLimit);
  expect(h.service.journal.get(limited.childId)?.phase).toBe("settled");

  h.engine.prepareDeletion(middle.childId, "delete-middle");
  await markDeleted(h, middle.childId);
  purge(h, middle.childId);
  // Work running when the middle thread went is still cancelled.
  expect(h.interrupts).toContain(running.childId);
  expect(h.service.journal.get(running.childId)).toMatchObject({
    phase: "settled",
    outcome: { outcome: "cancelled" },
  });

  const sent = h.service.command("carry-on", {
    type: "thread.send",
    threadId: limited.childId,
    input: [{ type: "text", text: "Carry on" }],
  });
  expect(sent).toMatchObject({ ok: true });
  // Past its reset, the person resumes it, and it runs again on its own.
  h.clock.advance(5001);
  await h.engine.flush();
  const resumed = h.service.command("resume", {
    type: "thread.resume",
    threadId: limited.childId,
    expectedRevision: h.engine.queue(limited.childId).revision,
  });
  expect(resumed).toMatchObject({ ok: true });
  await h.engine.flush();
  await h.emit(limited.childId, start);
  expect(h.store.getThread(limited.childId)?.status.state).toBe("working");
  // Its edge stays settled: nothing is reported to the middle thread that is gone.
  expect(h.service.journal.get(limited.childId)).toMatchObject({ phase: "settled" });
  expect(h.service.journal.nextWake()).toBeUndefined();
  expect(missingState(h)).toEqual([]);
});
