import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { grantPublicKey, policyBodySha256, signOrgRoster } from "@ace/account-grant";
import { Command, ThreadId, type CommandPayload } from "@ace/protocol";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { daemonFixture } from "../agent-control/daemon-test-support.ts";
import { setup } from "../agent-control/test-support.ts";
import { commandContext } from "../commands.ts";
import { sessionContainment } from "./containment.ts";
import { BackendUnreachable, memberWork } from "./member-work.ts";
import { memberWorkStore } from "./store.ts";
import { stopMemberTree } from "./wire.ts";

/*
 * The member gate on a real daemon with scripted providers (ADR 0209 §7): every thread here is
 * in Mia's tree, as the access policy will say. While she may run work it runs. Once a roster
 * revokes her, or her lease runs out, nothing more reaches a provider for her tree: no message,
 * no answer to the agent's question, no new session, no delegation. A tree a stop ended takes
 * work again only after her own proven input resumes it. The daemon's own entry points enforce
 * it, not the caller.
 */

const org = "org_01ACME";
const host = "A".repeat(52);
const key = { id: "k1", privateKey: new Uint8Array(32).fill(9) };
const minute = 60_000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

/** A daemon whose every thread is in Mia's tree, with her member work offline on its own clock. */
async function miasDaemon(answerable = false) {
  const dir = mkdtempSync(join(tmpdir(), "ace-member-gate-"));
  dirs.push(dir);
  const db = new DatabaseSync(join(dir, "members.sqlite"));
  const clock = { wall: Date.now(), mono: 0 };
  let stopper: Parameters<typeof stopMemberTree>[0] | undefined;
  let ids = 0;
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
    wall: () => clock.wall,
    monotonic: () => clock.mono,
    delay: () => () => {},
    id: () => `start-${++ids}`,
  });
  expect(work.takeRoster(roster(1, clock.wall, { user_mia: "active" }))).toBe("taken");
  // The tree's root is the first thread there is: the one the fixture starts.
  let root: ThreadId | undefined;
  const f = await daemonFixture(
    undefined,
    {
      memberWork: work,
      ownerOf: (thread) => ({ account: "user_mia", root: (root ??= thread) }),
    },
    {},
    answerable ? setup({}, undefined, true) : undefined,
  );
  const engine = f.daemon.engine;
  if (!engine) throw new Error("No engine");
  stopper = { engine, delegations: f.controls.delegations };
  const command = async (id: string, payload: CommandPayload) => {
    const result = await engine.handler.handle(
      Command.parse({ id, deviceId: "person", payload }),
      commandContext(f.daemon.store),
    );
    await engine.flush();
    return result;
  };
  const say = (id: string, text: string) =>
    command(id, {
      type: "thread.send",
      threadId: f.caller.threadId,
      input: [{ type: "text", text }],
    });
  const reached = (thread: ThreadId = f.caller.threadId) => f.h.inputs.get(thread) ?? [];
  const advance = (ms: number) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  const close = async () => {
    await f.daemon.close();
    db.close();
  };
  return { f, engine, work, clock, command, say, reached, advance, close };
}

it("a revoked member's tree takes no new input and delegates nowhere", async () => {
  const { f, work, clock, say, reached, close } = await miasDaemon();
  try {
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
    // Active: her input reaches the provider, and a delegation elsewhere gets as far as the
    // machine links (none here).
    expect(reached()).toContain("plan");
    await expect(elsewhere()).rejects.toThrow("That machine is not available to agents");

    expect(work.takeRoster(roster(2, clock.wall, {}))).toBe("taken");
    await work.pass();
    await say("after", "do more");
    expect(reached()).not.toContain("do more");
    await expect(elsewhere()).rejects.toThrow("This agent is being stopped");
    expect(f.daemon.store.getThread(f.caller.threadId)?.status.state).not.toBe("done");
  } finally {
    await close();
  }
});

it("once the lease runs out, no answer to the agent's question and no new session reach a provider", async () => {
  const { f, engine, command, reached, advance, close } = await miasDaemon(true);
  try {
    const root = f.caller.threadId;
    const question = Object.values(f.daemon.store.snapshotThread(root).interactions).find(
      (interaction) => interaction.state === "pending",
    );
    if (!question) throw new Error("No question");
    // No pass has run yet to stop the tree: only the gate stands in the way.
    advance(16 * minute);
    const answered = await command("answer", {
      type: "interaction.resolve",
      interactionId: question.id,
      resolution: { kind: "question", answers: { choice: ["safe"] } },
    });
    // Taken as a command, but it never reaches the provider: the question still waits.
    expect(answered.ok).toBe(true);
    const after = f.daemon.store.snapshotThread(root).interactions[question.id];
    expect(after?.state).toBe("pending");
    const child = await f.call({
      op: "delegate_task",
      requestId: "late-child",
      provider: "claude",
      task: "Start late",
      role: "late",
      wait: false,
    });
    await engine.flush();
    const childId = z.object({ threadId: ThreadId }).parse(child.data).threadId;
    // Refused before its provider was ever asked for a session, let alone sent anything.
    expect(f.h.contexts.has(childId)).toBe(false);
    expect(reached(childId)).toEqual([]);
  } finally {
    await close();
  }
});

it("a tree a stop ended takes no input, from a person or an engine continuation, until its owner's proven input resumes it", async () => {
  const { f, work, clock, command, say, reached, advance, close } = await miasDaemon();
  try {
    const root = f.caller.threadId;
    advance(16 * minute);
    await work.pass();
    expect(work.stopReason(root)).toBe("lease_expired");
    // Mia is still in the organization; the backend is back.
    work.takeRoster(roster(1, clock.wall, { user_mia: "active" }));
    // A send with no origin, as a person's command or an engine continuation arrives, is not
    // Mia's proven input: the tree stays stopped.
    await say("unproven", "go on");
    expect(reached()).not.toContain("go on");
    // The access policy admits her own proven input, her Try again: the tree resumes and takes
    // what she sent.
    expect(work.resume("user_mia", root)).toBe(true);
    const queue = f.daemon.store.getThread(root)?.queue;
    await command("again", {
      type: "queue.resume",
      threadId: root,
      expectedRevision: queue?.revision ?? 0,
    });
    expect(reached()).toContain("go on");
  } finally {
    await close();
  }
});
