import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { grantPublicKey, policyBodySha256, signOrgRoster } from "@ace/account-grant";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { commandContext } from "../commands.ts";
import { sessionContainment } from "./containment.ts";
import { BackendUnreachable, memberWork } from "./member-work.ts";
import { memberWorkStore } from "./store.ts";
import { stopMemberTree } from "./wire.ts";

/*
 * The member gate on a real daemon with scripted providers (ADR 0209 §7): every thread here is
 * Mia's, as the access policy will say. While she is active her work runs; once a roster revokes
 * her, a message to her tree never reaches a provider, and her tree can't delegate to another
 * host. The daemon's own entry points enforce it, not the caller.
 */

const org = "org_01ACME";
const host = "A".repeat(52);
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function roster(version: number, members: Record<string, string>) {
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
      { org, host, epoch: 1, version, at: Date.now(), body_sha256: policyBodySha256(body) },
      key,
    ),
  };
}

it("a revoked member's tree takes no new input and delegates nowhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ace-member-gate-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "members.sqlite"));
  let stopper: Parameters<typeof stopMemberTree>[0] | undefined;
  const work = memberWork({
    store: memberWorkStore({ atomic: (run) => run(db) }),
    org: () => org,
    host: () => host,
    fetchRoster: async () => {
      throw new BackendUnreachable("offline");
    },
    keys: () => ({ keys: [grantPublicKey(key)] }),
    stopTree: async (root, reason) =>
      stopper ? stopMemberTree(stopper, root, reason) : "unconfirmed",
    containment: sessionContainment,
    wall: Date.now,
    monotonic: () => performance.now(),
    delay: () => () => {},
  });
  expect(work.takeRoster(roster(1, { user_mia: "active" }))).toBe("taken");
  const f = await daemonFixture(undefined, {
    memberWork: work,
    ownerOf: (thread) => ({ account: "user_mia", root: thread }),
  });
  try {
    const engine = f.daemon.engine;
    if (!engine) throw new Error("No engine");
    stopper = { engine, delegations: f.controls.delegations };
    const root = f.caller.threadId;
    const say = async (id: string, text: string) => {
      const payload: CommandPayload = {
        type: "thread.send",
        threadId: root,
        input: [{ type: "text", text }],
      };
      engine.handler.handle(
        Command.parse({ id, deviceId: "person", payload }),
        commandContext(f.daemon.store),
      );
      await engine.flush();
    };
    const elsewhere = () =>
      f.call({
        op: "delegate_task",
        requestId: `remote-${Math.random()}`,
        machine: "box",
        provider: "codex",
        task: "Run it there",
        role: "remote",
        wait: false,
      });
    const reached = () => f.h.inputs.get(ThreadId.parse(root)) ?? [];

    // Active: her input reaches the provider, and a delegation elsewhere gets as far as the
    // machine links (none here).
    expect(reached()).toContain("plan");
    await expect(elsewhere()).rejects.toThrow("That machine is not available to agents");

    expect(work.takeRoster(roster(2, {}))).toBe("taken");
    await work.pass();
    await say("after", "do more");
    expect(reached()).not.toContain("do more");
    await expect(elsewhere()).rejects.toThrow("This agent is being stopped");
    expect(f.daemon.store.getThread(root)?.status.state).not.toBe("done");
  } finally {
    await f.daemon.close();
    db.close();
  }
});
