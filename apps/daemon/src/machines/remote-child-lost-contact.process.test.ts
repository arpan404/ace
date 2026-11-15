import { expect, it } from "vitest";
import { Command, type McpAttribution, type ThreadId } from "@ace/protocol";
import type { setup } from "../agent-control/test-support.ts";
import { REMOTE_CHILD_LEASE_MS } from "../liveness/lease.ts";
import { REMOTE_STOP, stopBound } from "../liveness/stop.ts";
import { STOP_TRACKING } from "./child-lost.ts";
import type { MachineChildren } from "./children.ts";
import {
  children,
  ids,
  live,
  notSent,
  parentView,
  parentWithChildren,
} from "./remote-child-test-support.ts";

/*
 * A child whose machine stops answering (still paired; the network is down or its daemon is not
 * answering), with a real parent engine and store and the other machine played in memory
 * (ADR 0153). Lost contact is not knowing: the parent is never read done on the strength of a
 * lease running out, and the person is asked, as for a child whose machine was unpaired.
 */

type Fixture = Awaited<ReturnType<typeof setup>>;

/** The parent's open questions. */
const asks = (f: Fixture, parent: McpAttribution) =>
  Object.values(f.store.snapshotThread(parent.threadId).interactions).filter(
    (interaction) => interaction.state === "pending",
  );

/** The person answers the question about the child: stop tracking it. */
function stopTracking(ledger: MachineChildren, interactionId: string) {
  return ledger.resolve(
    Command.parse({
      id: `stop-tracking-${interactionId}`,
      deviceId: "person",
      payload: {
        type: "interaction.resolve",
        interactionId,
        resolution: { kind: "approval", optionId: STOP_TRACKING },
      },
    }),
  );
}

/** A working child, its parent's own turn over, then its machine goes silent past the lease. */
async function silentChild(leaseMs?: number) {
  const fixture = await parentWithChildren(1, leaseMs);
  const { f, parent, rijan, at } = fixture;
  const [id] = ids;
  if (!id) throw new Error("no child");
  rijan.views.set(id, {
    ...notSent(id),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  await at(f.clock.now() + 1_000);
  // The parent's own turn ends: only its child keeps it open.
  await f.complete(parent.threadId, "Delegated the review.");
  expect(live).toContain(parentView(f, parent).status.state);

  rijan.silent = true;
  const quiet = f.clock.now();
  // Asked and not answered: its lease runs from this read.
  await at(quiet);
  await at(quiet + (leaseMs ?? REMOTE_CHILD_LEASE_MS) + 1_000);
  return { ...fixture, id, quiet };
}

it("a working child whose machine goes silent past the lease keeps its parent from reading done, and the person is asked", async () => {
  const { f, parent, ledger, id } = await silentChild();

  const view = parentView(f, parent);
  expect(view.status.state).toBe("needs_you");
  expect(view.holds.map((hold) => hold.status)).toEqual(["running"]);
  expect(view.forest.roots.some((root) => root.live)).toBe(true);
  expect(view.rows).toEqual([
    expect.objectContaining({
      live: true,
      agent: expect.objectContaining({ machine: expect.objectContaining({ contact: "lost" }) }),
    }),
  ]);
  const [ask] = asks(f, parent);
  expect(asks(f, parent)).toHaveLength(1);
  expect(ask?.request).toMatchObject({
    kind: "approval",
    title: expect.stringContaining("Lost contact with MacBook Pro Rijan since"),
  });

  // A wait and agents_status read it as needing the person, never as failed or done.
  const watched = ledger.watched(id as ThreadId)?.view;
  expect(watched).toMatchObject({ state: "needs_you", contact: "lost" });
  expect(watched?.step).toContain("MacBook Pro Rijan hasn't answered for 10 min");
  expect(watched?.needs?.[0]?.interactionId).toBe(ask?.id);
});

it("a child that lost contact reports again: the question closes by itself and it reads working, still holding its parent", async () => {
  const { f, parent, rijan, ledger, id, at } = await silentChild();
  expect(asks(f, parent)).toHaveLength(1);

  // Polling goes on at the scheduler's backed-off pace; the machine answers again.
  rijan.silent = false;
  for (let poll = 0; poll < 4; poll++) await at(f.clock.now() + 30_000);
  const back = parentView(f, parent);
  expect(asks(f, parent)).toEqual([]);
  expect(ledger.watched(id)?.view).toMatchObject({ state: "working" });
  expect(ledger.watched(id)?.view.contact).toBeUndefined();
  expect(back.holds.map((hold) => hold.status)).toEqual(["running"]);
  expect(back.status.state).toBe("working");

  // It ends there: the hold ends on that real end, and the parent finishes.
  rijan.views.set(id, {
    ...notSent(id),
    state: "done",
    status: { state: "done" },
    result: "Reviewed.",
    truncated: false,
  });
  await at(f.clock.now() + 30_000);
  expect(parentView(f, parent).holds.map((hold) => hold.status)).toEqual(["completed"]);
  expect(live).not.toContain(parentView(f, parent).status.state);
});

it("stopping tracking a child that lost contact settles it cancelled and lets its parent finish; a late report doesn't revive it", async () => {
  const { f, parent, rijan, ledger, id, at } = await silentChild();
  const [ask] = asks(f, parent);
  if (!ask) throw new Error("No question for the person");

  expect(stopTracking(ledger, ask.id)).toMatchObject({ ok: true });
  await f.engine.flush();
  expect(asks(f, parent)).toEqual([]);
  const ended = ledger.watched(id)?.view;
  expect(ended).toMatchObject({ state: "cancelled" });
  expect(ended?.result).toContain("Its work there may still be running");
  expect(parentView(f, parent).holds.map((hold) => hold.status)).toEqual(["stopped"]);
  expect(live).not.toContain(parentView(f, parent).status.state);

  rijan.silent = false;
  for (let poll = 0; poll < 4; poll++) await at(f.clock.now() + 30_000);
  expect(ledger.watched(id)?.view.state).toBe("cancelled");
  expect(asks(f, parent)).toEqual([]);
  expect(live).not.toContain(parentView(f, parent).status.state);
});

it("a daemon restart while contact is lost keeps the one question, and it still closes when the machine answers", async () => {
  const { f, parent, rijan, ledger, id, at } = await silentChild();
  const [ask] = asks(f, parent);
  ledger.close();

  const restarted = children(f, rijan);
  for (let poll = 0; poll < 6; poll++) await at(f.clock.now() + 30_000, restarted);
  expect(asks(f, parent).map((open) => open.id)).toEqual([ask?.id]);
  expect(restarted.watched(id)?.view).toMatchObject({ state: "needs_you", contact: "lost" });
  expect(parentView(f, parent).status.state).toBe("needs_you");

  rijan.silent = false;
  for (let poll = 0; poll < 4; poll++) await at(f.clock.now() + 30_000, restarted);
  expect(asks(f, parent)).toEqual([]);
  expect(restarted.watched(id)?.view.state).toBe("working");
  restarted.close();
});

it("a wait on a child whose machine goes silent returns once it loses contact, needing the person, instead of holding the parent's turn", async () => {
  const lease = 60_000;
  const { f, parent, rijan, ledger, at } = await parentWithChildren(1, lease);
  const [id] = ids;
  if (!id) throw new Error("no child");
  rijan.views.set(id, {
    ...notSent(id),
    state: "working",
    status: { state: "working", agents: 1 },
  });
  await at(f.clock.now() + 1_000);
  f.service.monitor.attachRemote(ledger);
  const caller = { sessionId: "s", threadId: parent.threadId, agentId: parent.agentId };
  let settled = false;
  const waiting = f.service.monitor
    .wait(
      caller,
      { threadIds: [id], mode: "all", timeoutSeconds: 600 },
      new AbortController().signal,
    )
    .finally(() => (settled = true));
  await at(f.clock.now() + 1_000);
  expect(settled).toBe(false);

  rijan.silent = true;
  // Asked and not answered: its lease runs from this read.
  await at(f.clock.now() + 1_000);
  await at(f.clock.now() + lease + 2_000);
  const result = await waiting;
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    status: "needs_you",
    threads: [expect.objectContaining({ threadId: id, state: "needs_you", contact: "lost" })],
  });
});

it("a child that lost contact can still be stopped: its question closes, it ends stopped for good, and a late report doesn't revive it", async () => {
  const { f, parent, rijan, ledger, id, at } = await silentChild();
  expect(asks(f, parent)).toHaveLength(1);

  expect(ledger.stop(id)).toBe(true);
  await at(f.clock.now() + 1);
  expect(asks(f, parent)).toEqual([]);
  await at(f.clock.now() + stopBound(REMOTE_STOP));
  expect(ledger.watched(id)?.view).toMatchObject({ state: "cancelled", contact: "unconfirmed" });
  expect(parentView(f, parent).holds.map((hold) => hold.status)).toEqual(["stopped"]);

  rijan.silent = false;
  await at(f.clock.now() + 10_000);
  expect(ledger.child(id)?.settled).toBe(true);
  expect(live).not.toContain(parentView(f, parent).status.state);
});

it("a child that lost contact whose machine is then unpaired asks only about the pairing", async () => {
  const { f, parent, rijan, at } = await silentChild();
  expect(asks(f, parent)).toHaveLength(1);

  rijan.paired = false;
  await at(f.clock.now() + 30_000);
  await at(f.clock.now() + 30_000);
  const open = asks(f, parent);
  expect(open).toHaveLength(1);
  expect(open[0]?.request).toMatchObject({ title: expect.stringContaining("no longer paired") });
  expect(parentView(f, parent).status.state).toBe("needs_you");
});
