import { expect, it, vi } from "vitest";
import { z } from "zod";
import { grantPublicKey, policyBodySha256, signOrgRoster } from "@ace/account-grant";
import { ThreadId } from "@ace/protocol";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { end, start } from "../engine/test-support.ts";
import { sessionContainment } from "./containment.ts";
import { BackendUnreachable, memberWork } from "./member-work.ts";
import { memberWorkStore } from "./store.ts";
import { memberStopFailures, stopMemberTree, type TreeStopDeps } from "./wire.ts";

/*
 * A real daemon with scripted providers (ADR 0209 §7): a member's tree is working, with its root
 * mid-turn and a delegated child running, when a roster that no longer lists the member arrives.
 * The next pass stops the whole tree through the engine: each part ends failed with why, no part
 * reads done, also one that settles while the stop is under way, and its children on other
 * hosts are sent the cross-machine stop.
 */

const org = "org_01ACME";
const host = "A".repeat(52);
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };

function roster(version: number, at: number, members: Record<string, string>) {
  const body = JSON.stringify({
    members: Object.entries(members).map(([account, status]) => ({
      account,
      status,
      role: "member",
    })),
    hosts: [{ id: host }],
  });
  return {
    body,
    statement: signOrgRoster(
      { org, host, epoch: 1, version, at, body_sha256: policyBodySha256(body) },
      key,
    ),
  };
}

/** A daemon whose root thread is mid-turn with one delegated child still working. */
async function workingTree() {
  const f = await daemonFixture();
  const engine = f.daemon.engine;
  if (!engine) throw new Error("No engine");
  const root = f.caller.threadId;
  const session = f.h.contexts.get(root);
  if (!session) throw new Error("No session");
  session.onFrame(f.h.frames.frame(start));
  await engine.flush();
  const delegated = await f.call({
    op: "delegate_task",
    requestId: "child",
    provider: "claude",
    task: "Do the child's part",
    role: "do-child",
    wait: false,
  });
  await engine.flush();
  const child = z.object({ threadId: ThreadId }).parse(delegated.data).threadId;
  const state = (id: ThreadId) => f.daemon.store.getThread(id)?.status.state;
  expect([state(root), state(child)]).toEqual(["working", "working"]);
  return { f, engine, root, child, state };
}

/** Mia's member work on that daemon, offline, holding the root's lease. */
function miasWork(stopper: TreeStopDeps, store: Parameters<typeof memberWorkStore>[0]) {
  const clock = { wall: Date.now() };
  const work = memberWork({
    store: memberWorkStore(store),
    org: () => org,
    host: () => host,
    fetchRoster: async () => {
      throw new BackendUnreachable("offline");
    },
    keys: () => ({ keys: [grantPublicKey(key)] }),
    stopTree: (tree, reason) => stopMemberTree(stopper, tree, reason),
    containment: sessionContainment,
    wall: () => clock.wall,
    monotonic: () => clock.wall,
    delay: () => () => {},
  });
  return { work, clock };
}

it("a revoked member's running tree stops, says why and never reads done", async () => {
  const { f, engine, root, child, state } = await workingTree();
  try {
    const cancelled: ThreadId[] = [];
    const remoteChild = ThreadId.parse("t_on_another_host");
    const { work, clock } = miasWork(
      {
        engine,
        delegations: f.controls.delegations,
        remote: {
          under: (tree) => (tree === root ? [remoteChild] : []),
          cancel: async (id) => cancelled.push(id),
        },
      },
      f.daemon.store,
    );
    expect(work.takeRoster(roster(1, clock.wall, { user_mia: "active" }))).toBe("taken");
    expect(work.admit("user_mia", root, "person")).toBe(true);
    await work.pass();
    expect([state(root), state(child)]).toEqual(["working", "working"]);

    clock.wall += 60_000;
    expect(work.takeRoster(roster(2, clock.wall, {}))).toBe("taken");
    await work.pass();
    // Stopped, and said why: neither the root nor its child reads done, or still working.
    await vi.waitFor(() => expect([state(root), state(child)]).toEqual(["failed", "failed"]));
    expect(f.daemon.store.getThread(root)?.queue?.lastFailure).toEqual(memberStopFailures.revoked);
    expect(engine.hasUnfinishedWork(root)).toBe(false);
    expect(work.stopReason(root)).toBe("revoked");
    expect(work.pendingStops()).toEqual([]);
    // The child on another host was sent the cross-machine stop.
    expect(cancelled).toEqual([remoteChild]);
    await work.close();
  } finally {
    await f.daemon.close();
  }
});

it("a child that finishes while its tree is being stopped still reads failed, not done", async () => {
  const { f, engine, root, child, state } = await workingTree();
  try {
    // Once the stop has begun and before it is awaited, the child's provider reports its turn
    // completed: a race with the rest of the stop.
    let raced = false;
    const { work, clock } = miasWork(
      {
        engine,
        delegations: f.controls.delegations,
        remote: {
          under: () => [ThreadId.parse("t_on_another_host")],
          cancel: async () => {
            raced = true;
            f.h.contexts.get(child)?.onFrame(f.h.frames.frame(end));
            await engine.flush();
          },
        },
      },
      f.daemon.store,
    );
    work.takeRoster(roster(1, clock.wall, { user_mia: "active" }));
    work.admit("user_mia", root, "person");
    work.takeRoster(roster(2, clock.wall + 1, {}));
    await work.pass();
    expect(raced).toBe(true);
    await engine.flush();
    expect([state(root), state(child)]).toEqual(["failed", "failed"]);
    await work.close();
  } finally {
    await f.daemon.close();
  }
});
