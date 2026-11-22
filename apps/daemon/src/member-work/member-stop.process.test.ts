import { expect, it, vi } from "vitest";
import { z } from "zod";
import { grantPublicKey, policyBodySha256, signOrgRoster } from "@ace/account-grant";
import { ThreadId } from "@ace/protocol";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { start } from "../engine/test-support.ts";
import { processGroupContainment } from "./containment.ts";
import { memberWork } from "./member-work.ts";
import { memberWorkStore } from "./store.ts";
import { memberStopFailures, stopMemberTree } from "./wire.ts";

/*
 * A real daemon with scripted providers (ADR 0209 §7): a member's tree is working, with its root
 * mid-turn and a delegated child running, when a roster that no longer lists the member arrives.
 * The next pass stops the whole tree through the engine: each part ends failed with why, and
 * no part of it reads done.
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
    statement: signOrgRoster({ org, host, version, at, body_sha256: policyBodySha256(body) }, key),
  };
}

it("a revoked member's running tree stops, says why and never reads done", async () => {
  const f = await daemonFixture();
  try {
    const engine = f.daemon.engine;
    if (!engine) throw new Error("No engine");
    const root = f.caller.threadId;
    // The root agent is mid-turn, and it delegated a child that is still working.
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

    let now = Date.now();
    const work = memberWork({
      store: memberWorkStore(f.daemon.store),
      org: () => org,
      host: () => host,
      fetchRoster: async () => {
        throw new Error("offline");
      },
      keys: () => ({ keys: [grantPublicKey(key)] }),
      stopTree: (tree, reason) =>
        stopMemberTree({ engine, delegations: f.controls.delegations }, tree, reason),
      containment: processGroupContainment(() => {}),
      now: () => now,
      delay: () => () => {},
    });
    expect(work.takeRoster(roster(1, now, { user_mia: "active" }))).toBe("taken");
    expect(work.hold("user_mia", root)).toBe(true);
    await work.pass();
    expect([state(root), state(child)]).toEqual(["working", "working"]);

    now += 60_000;
    expect(work.takeRoster(roster(2, now, {}))).toBe("taken");
    await work.pass();
    // Stopped, and said why: neither the root nor its child reads done, or still working.
    await vi.waitFor(() => expect([state(root), state(child)]).toEqual(["failed", "failed"]));
    expect(f.daemon.store.getThread(root)?.queue?.lastFailure).toEqual(memberStopFailures.revoked);
    expect(engine.hasUnfinishedWork(root)).toBe(false);
    expect(work.stopReason(root)).toBe("revoked");
    await work.close();
  } finally {
    await f.daemon.close();
  }
});
