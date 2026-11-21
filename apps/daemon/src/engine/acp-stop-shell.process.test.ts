import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { antigravityQuirks, createAcpAdapter } from "@ace/adapter-acp";
import { AcpIdentity } from "@ace/protocol";
import { INTERRUPT_GRACE_MS } from "../liveness/stop.ts";
import type { EngineOptions } from "./index.ts";
import { cleanupRecovery, fixture } from "./recovery-test-support.ts";
import { scriptFrames } from "./test-support.ts";

/*
 * A Stop always settles (ADR 0052), even over work the provider can't stop: an Antigravity
 * shell that outlives a normal reply is reported unstoppable and blocks new prompts while it
 * runs, and its prompt already ended, so the Stop's cancel reaches nothing.
 */
afterEach(cleanupRecovery);

// The ACP double: "antigravity-shell" ends the prompt and leaves its shell running for good.
const server = fileURLToPath(
  new URL(
    "../../../../packages/adapter-acp/src/testing/uncertain-shell-server.ts",
    import.meta.url,
  ),
);

/** An Antigravity thread on the ACP double, recording each session it opens and what it took. */
async function antigravity(first = "antigravity-shell", beforeSend?: EngineOptions["beforeSend"]) {
  const frames = scriptFrames();
  const h = await fixture([], frames, {
    provider: "antigravity",
    capabilities: antigravityQuirks.capabilities("1.2.1"),
    permissionSettings: async () => ({ access: "full-access" as const }),
    ...(beforeSend ? { beforeSend } : {}),
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
  const id = first === "hold-for-steer" ? startHeldPrompt() : await h.create(first);
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
  if (first === "hold-for-steer")
    await expect
      .poll(() => Object.values(h.store.snapshotThread(id).items))
      .toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          call: expect.objectContaining({ status: "running" }),
        }),
      );
  else await expect.poll(() => running().length).toBe(1);
  // Waiting on the shell, or working on the late tool: never done while it runs.
  expect(h.store.getThread(id)?.status.state).not.toBe("done");
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
  } finally {
    if (h.store.snapshotThread(id).runs[active.id]?.state === "active")
      h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  }
});

test("a Stop over an Antigravity shell that outlived its reply closes the session once its grace runs out", async () => {
  const { h, id, sessions, running, send } = await antigravity();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  // Within its grace the shell may still end by itself: the thread waits on it.
  expect(running()).toHaveLength(1);
  expect(h.store.getThread(id)?.status).toMatchObject({ state: "waiting" });
  expect(sessions.map((session) => session.closed)).toEqual([false]);

  h.clock.advance(h.clock.now() + INTERRUPT_GRACE_MS);
  await expect.poll(() => sessions[0]?.closed).toBe(true);
  await expect.poll(() => running().length).toBe(0);
  await expect.poll(() => h.store.getThread(id)?.status.state).toBe("done");
  // The person carries on: the next message reaches a session opened for it.
  expect(send("next")).toBe(true);
  await h.engine.flush();
  await expect.poll(() => sessions[1]?.prompts).toEqual(["next"]);
  expect(sessions[0]?.prompts).toEqual(["antigravity-shell"]);
  expect(h.engine.queue(id).lastFailure).toBeNull();
});

test("a message the shell kept out still leaves the close to come, and then reaches the session opened for it", async () => {
  const { h, id, sessions, send } = await antigravity();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  // Sent within the grace: the session takes no prompt beside the shell, so it is held unsent.
  expect(send("while it runs")).toBe(true);
  await h.engine.flush();
  expect(sessions.map((session) => session.prompts)).toEqual([["antigravity-shell"]]);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "not_sent", pendingCount: 1 });

  // Nothing was taken, so the close still comes; the person sends the held message again.
  h.clock.advance(h.clock.now() + INTERRUPT_GRACE_MS);
  await expect.poll(() => sessions[0]?.closed).toBe(true);
  await h.engine.flush();
  expect(
    h.command({
      type: "queue.resume",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  await expect.poll(() => sessions[1]?.prompts).toEqual(["while it runs"]);
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

test("a send still preparing when the grace ends, then kept out by the shell, still gets the close", async () => {
  // The send after the Stop is held while it prepares (its Git checkpoint, say).
  const preparing = Promise.withResolvers<void>();
  let sends = 0;
  const { h, id, sessions, send } = await antigravity("antigravity-shell", async () => {
    if (sends++ === 1) await preparing.promise;
  });
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  expect(send("just in time")).toBe(true);
  await expect.poll(() => sends).toBe(2);

  // The grace ends while the send is still being carried out: how it ends decides.
  // (No flush here: it would wait on the send this test holds.)
  h.clock.advance(h.clock.now() + INTERRUPT_GRACE_MS);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(sessions.map((session) => session.closed)).toEqual([false]);
  // The shell keeps it out: nothing was taken, so the close comes.
  preparing.resolve();
  await expect.poll(() => sessions[0]?.closed).toBe(true);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "not_sent", pendingCount: 1 });
  expect(
    h.command({
      type: "queue.resume",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  await expect.poll(() => sessions[1]?.prompts).toEqual(["just in time"]);
});
