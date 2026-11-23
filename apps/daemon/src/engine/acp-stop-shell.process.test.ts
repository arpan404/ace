import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { antigravityQuirks, createAcpAdapter } from "@ace/adapter-acp";
import { AcpIdentity } from "@ace/protocol";
import { INTERRUPT_GRACE_MS } from "../liveness/stop.ts";
import { cleanupRecovery, fixture } from "./recovery-test-support.ts";
import { scriptFrames } from "./test-support.ts";

/*
 * A Stop always settles (ADR 0052), even over work the provider can't stop: a tool Antigravity
 * reports after its reply holds the next prompt, and its prompt already ended, so the Stop's
 * cancel reaches nothing. A shell left running after a finished turn holds nothing: Antigravity
 * takes the next prompt beside it and reports its end there (ADR 0109).
 */
afterEach(cleanupRecovery);

// The ACP double: "antigravity-shell" finishes the turn with its shell running, "report-shell"
// reports that shell done, and "late-tool" reports a tool after its reply that never ends.
const server = fileURLToPath(
  new URL(
    "../../../../packages/adapter-acp/src/testing/uncertain-shell-server.ts",
    import.meta.url,
  ),
);

/** An Antigravity thread on the ACP double, recording each session it opens and what it took. */
async function antigravity(first: string) {
  const frames = scriptFrames();
  const h = await fixture([], frames, {
    provider: "antigravity",
    capabilities: antigravityQuirks.capabilities("1.2.1"),
    permissionSettings: async () => ({ access: "full-access" as const }),
  });
  const adapter = createAcpAdapter(antigravityQuirks, {
    // The release ace admits, so the session's saved conversation loads again after a close.
    resolveLaunch: async () => ({
      identity: AcpIdentity.parse({
        acpAgentId: "antigravity",
        installationId: "test-install",
        instanceId: "test-instance",
      }),
      version: "1.2.1",
      command: process.execPath,
      args: [server],
      env: {},
    }),
    acceptsIdentity: () => true,
  });
  const sessions: { prompts: string[]; closed: boolean }[] = [];
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        const seen = { prompts: [] as string[], closed: false };
        sessions.push(seen);
        // The session is a class instance: only its sending and closing are watched.
        const send: typeof session.send = async (input, ...rest) => {
          await session.send(input, ...rest);
          for (const part of input) if (part.type === "text") seen.prompts.push(part.text);
        };
        const close: typeof session.close = async (reason) => {
          seen.closed = true;
          await session.close(reason);
        };
        return new Proxy(session, {
          get: (target, key) =>
            key === "send" ? send : key === "close" ? close : Reflect.get(target, key, target),
        });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "", version: "1.2.1" },
  );
  const id = first.startsWith("hold-for-steer") ? startHeldPrompt() : await h.create(first);
  function startHeldPrompt() {
    const result = h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "antigravity",
      model: "model",
      input: [{ type: "text", text: first }],
    });
    if (!result.ok) throw new Error(result.error);
    const thread = h.store.listThreads()[0];
    if (!thread) throw new Error("Missing created thread");
    return thread.id;
  }
  const running = () =>
    Object.values(h.store.snapshotThread(id).backgroundTasks).filter(
      (task) => task.status === "running",
    );
  if (first.startsWith("hold-for-steer"))
    await expect
      .poll(() => Object.values(h.store.snapshotThread(id).items))
      .toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          call: expect.objectContaining({ status: "running" }),
        }),
      );
  else await expect.poll(() => running().length).toBe(1);
  const send = (text: string) =>
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text }] }).ok;
  return { h, id, sessions, running, send };
}

test("a person's ACP steer cancels its target turn and sends the follow-up once", async () => {
  const { h, id, sessions } = await antigravity("hold-for-steer");
  const active = Object.values(h.store.snapshotThread(id).runs).find(
    (run) => run.state === "active",
  );
  if (!active) throw new Error("Expected the first prompt to be active");

  expect(
    h.command({
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text: "read a different file" }],
      delivery: "steer",
      runId: active.id,
    }).ok,
  ).toBe(true);

  try {
    await expect
      .poll(() => sessions.map((session) => session.prompts))
      .toEqual([["hold-for-steer", "read a different file"]]);
    expect(h.store.snapshotThread(id).runs[active.id]).toMatchObject({
      state: "interrupted",
      endedBy: "steer",
    });
    expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, paused: false });
    // The steer carries the turn on: its run is numbered as the same turn, and the agent's
    // word that ace cancelled its prompt is not shown as its answer.
    const runs = Object.values(h.store.snapshotThread(id).runs);
    await expect.poll(() => Object.keys(h.store.snapshotThread(id).runs).length).toBe(2);
    expect(Object.values(h.store.snapshotThread(id).runs).map((run) => run.turn)).toEqual([
      runs[0]?.turn,
      runs[0]?.turn,
    ]);
    const said = Object.values(h.store.snapshotThread(id).items).flatMap((item) =>
      item.type === "message" && item.role === "assistant"
        ? item.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    );
    expect(said.join("")).not.toContain("cancelled by the client");
    // The thread never reads done while the steer is on its way to the agent.
    const statuses = h.store
      .readEvents({ afterSeq: 0, threadId: id, limit: 10_000 })
      .flatMap((event) =>
        event.payload.type === "thread.updated" && event.payload.status
          ? [event.payload.status.state]
          : [],
      );
    // Working, then waiting while the cancelled turn makes way, then working on the steer.
    const steered = statuses.slice(
      statuses.indexOf("working"),
      statuses.lastIndexOf("working") + 1,
    );
    expect(steered).toEqual(["working", "waiting", "working"]);
  } finally {
    if (h.store.snapshotThread(id).runs[active.id]?.state === "active")
      h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  }
});

test("a second ACP steer cancels the turn started by the first steer", async () => {
  const { h, id, sessions } = await antigravity("hold-for-steer:1");
  const activeRun = () =>
    Object.values(h.store.snapshotThread(id).runs).find((run) => run.state === "active");
  const firstRun = activeRun();
  if (!firstRun) throw new Error("Expected the first prompt to be active");

  try {
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "hold-for-steer:2" }],
        delivery: "steer",
        runId: firstRun.id,
      }).ok,
    ).toBe(true);

    // Wait for the first steer to cancel the first run and start its own running turn.
    await expect
      .poll(() => {
        const run = activeRun();
        return run && run.id !== firstRun.id ? run.id : undefined;
      })
      .toBeTruthy();
    const secondRun = activeRun();
    if (!secondRun) throw new Error("Expected the steered prompt to be active");

    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "final steer" }],
        delivery: "steer",
        runId: secondRun.id,
      }).ok,
    ).toBe(true);

    await expect
      .poll(() => sessions.map((session) => session.prompts))
      .toEqual([["hold-for-steer:1", "hold-for-steer:2", "final steer"]]);
    const runs = h.store.snapshotThread(id).runs;
    expect(runs[firstRun.id]).toMatchObject({ state: "interrupted", endedBy: "steer" });
    expect(runs[secondRun.id]).toMatchObject({ state: "interrupted", endedBy: "steer" });
    expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, paused: false });
  } finally {
    if (activeRun()) h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  }
});

test("an ACP steer that cancels the active turn runs ahead of an earlier queued follow-up", async () => {
  const { h, id, sessions } = await antigravity("hold-for-steer:1");
  const active = Object.values(h.store.snapshotThread(id).runs).find(
    (run) => run.state === "active",
  );
  if (!active) throw new Error("Expected the first prompt to be active");

  try {
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "afterwards" }],
        delivery: "queue",
      }).ok,
    ).toBe(true);
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "do this first" }],
        delivery: "steer",
        runId: active.id,
      }).ok,
    ).toBe(true);

    await expect
      .poll(() => sessions.map((session) => session.prompts))
      .toEqual([["hold-for-steer:1", "do this first", "afterwards"]]);
    expect(h.store.snapshotThread(id).runs[active.id]).toMatchObject({
      state: "interrupted",
      endedBy: "steer",
    });
    expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, paused: false });
  } finally {
    if (h.store.snapshotThread(id).runs[active.id]?.state === "active")
      h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  }
});

test("a Stop over a tool first reported after the reply, which holds the next prompt, closes the session too", async () => {
  const { h, id, sessions, running, send } = await antigravity("late-tool");
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  expect(running()).toHaveLength(1);
  expect(sessions.map((session) => session.closed)).toEqual([false]);

  h.clock.advance(h.clock.now() + INTERRUPT_GRACE_MS);
  await expect.poll(() => sessions[0]?.closed).toBe(true);
  await expect.poll(() => running().length).toBe(0);
  expect(send("next")).toBe(true);
  await h.engine.flush();
  await expect.poll(() => sessions[1]?.prompts).toEqual(["next"]);
});

test("a message sent beside an Antigravity shell left running after its reply reaches the agent, which reports the shell done", async () => {
  const { h, id, sessions, running, send } = await antigravity("antigravity-shell");
  // The turn finished: the thread is done, the command listed as left running.
  await expect.poll(() => h.store.getThread(id)?.status.state).toBe("done");
  expect(send("report-shell")).toBe(true);
  await h.engine.flush();
  await expect.poll(() => sessions[0]?.prompts).toEqual(["antigravity-shell", "report-shell"]);
  await expect.poll(() => running().length).toBe(0);
  expect(h.engine.queue(id).lastFailure).toBeNull();
  expect(sessions.map((session) => session.closed)).toEqual([false]);
});
