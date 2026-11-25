import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { antigravityQuirks, createAcpAdapter } from "@ace/adapter-acp";
import { AcpIdentity, type ThreadId } from "@ace/protocol";
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
async function antigravity(first: string, releaseDir?: string) {
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
      env: releaseDir
        ? {
            ACE_ACP_RELEASE_DIR: join(releaseDir, "release"),
            ACE_ACP_EVENT_LOG: join(releaseDir, "events.log"),
          }
        : {},
    }),
    acceptsIdentity: () => true,
  });
  const sessions: { prompts: string[]; cancels: string[]; closed: boolean }[] = [];
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        const session = await adapter.openSession(ctx);
        const seen = { prompts: [] as string[], cancels: [] as string[], closed: false };
        sessions.push(seen);
        // The session is a class instance: only its sending, cancelling and closing are watched.
        const send: typeof session.send = async (input, ...rest) => {
          await session.send(input, ...rest);
          for (const part of input) if (part.type === "text") seen.prompts.push(part.text);
        };
        const interrupt: typeof session.interrupt = async (target) => {
          seen.cancels.push(target.agent ?? "root");
          await session.interrupt(target);
        };
        const close: typeof session.close = async (reason) => {
          seen.closed = true;
          await session.close(reason);
        };
        return new Proxy(session, {
          get: (target, key) =>
            key === "send"
              ? send
              : key === "interrupt"
                ? interrupt
                : key === "close"
                  ? close
                  : Reflect.get(target, key, target),
        });
      },
    },
    { installed: true, auth: "logged_in", loginHint: "", version: "1.2.1" },
  );
  // A held prompt never answers, so the thread's creation is not awaited as a whole.
  const held = first.startsWith("hold-");
  const id = held ? startHeldPrompt() : await h.create(first);
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
  if (held)
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

/** Where a test releases the double's held shell or turn, one marker file at a time. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "ace-acp-release-"));
  mkdirSync(join(dir, "release"));
  return dir;
}
function release(dir: string, step: number) {
  writeFileSync(join(dir, "release", `release-${step}`), "");
}
/** What the double saw, in order: a release it honoured and a cancel it took. */
function events(dir: string) {
  const path = join(dir, "events.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}
function activeRootRun(h: Awaited<ReturnType<typeof antigravity>>["h"], id: ThreadId) {
  return Object.values(h.store.snapshotThread(id).runs).find((run) => run.state === "active");
}
function toolCalls(h: Awaited<ReturnType<typeof antigravity>>["h"], id: ThreadId) {
  return Object.values(h.store.snapshotThread(id).items).filter(
    (item) => item.type === "tool_call",
  );
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

test("an ACP steer waits for the running command, then cancels once and sends the follow-up once", async () => {
  const dir = tempDir();
  const { h, id, sessions } = await antigravity("hold-shell-for-steer", dir);
  const active = activeRootRun(h, id);
  if (!active) throw new Error("Expected the first prompt to be active");

  try {
    expect(
      h.command({
        type: "thread.send",
        threadId: id,
        input: [{ type: "text", text: "read another file" }],
        delivery: "steer",
        runId: active.id,
      }).ok,
    ).toBe(true);
    // Held: the steer lane runs at once and spares the command, which is still running.
    expect(sessions[0]?.cancels).toEqual([]);
    expect(h.engine.queue(id).pendingCount).toBe(1);
    expect(
      Object.values(h.store.snapshotThread(id).items).filter(
        (item) => item.type === "tool_call" && item.call.detail.kind === "shell",
      ),
    ).toMatchObject([{ type: "tool_call", complete: false }]);

    // The test releases the command: one cancel, and the steer's prompt goes in once.
    release(dir, 1);
    await expect.poll(() => sessions[0]?.cancels, { timeout: 5000 }).toEqual(["root"]);
    await expect
      .poll(() => sessions[0]?.prompts, { timeout: 5000 })
      .toEqual(["hold-shell-for-steer", "read another file"]);
    await h.engine.flush();
    expect(sessions[0]?.cancels).toEqual(["root"]);
    expect(sessions[0]?.prompts).toEqual(["hold-shell-for-steer", "read another file"]);
    expect(h.store.snapshotThread(id).runs[active.id]).toMatchObject({
      state: "interrupted",
      endedBy: "steer",
    });
    expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, paused: false });
    // The double saw the release before any cancel: nothing stopped the running command.
    expect(events(dir)).toEqual(["release", "cancel"]);
  } finally {
    if (h.store.snapshotThread(id).runs[active.id]?.state === "active")
      h.command({ type: "thread.interrupt", threadId: id, cascade: true });
    rmSync(dir, { recursive: true, force: true });
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

test("a Stop over a shell Antigravity left running ends it with the session at once", async () => {
  const { h, id, sessions, running, send } = await antigravity("antigravity-shell");
  await expect.poll(() => h.store.getThread(id)?.status.state).toBe("done");
  expect(Object.values(h.store.snapshotThread(id).backgroundTasks)).toMatchObject([
    { status: "running", endsWithSession: true },
  ]);
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  // No grace: nothing would report the shell ending by itself. The clock never moves here.
  await expect.poll(() => sessions[0]?.closed).toBe(true);
  await expect.poll(() => running().length).toBe(0);
  expect(send("next")).toBe(true);
  await h.engine.flush();
  await expect.poll(() => sessions[1]?.prompts).toEqual(["next"]);
  expect(h.engine.queue(id).lastFailure).toBeNull();
});

/** The person's own steer at whatever turn runs now, as the app sends it. */
const steer = (h: Awaited<ReturnType<typeof antigravity>>["h"], id: ThreadId, text: string) =>
  h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text }],
    delivery: "steer",
  }).ok;
const queueMessage = (
  h: Awaited<ReturnType<typeof antigravity>>["h"],
  id: ThreadId,
  text: string,
) =>
  h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text }],
    delivery: "queue",
  }).ok;
const queuedTexts = (h: Awaited<ReturnType<typeof antigravity>>["h"], id: ThreadId) =>
  h.engine.queue(id).messages.map((message) => ({
    text: message.input.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    delivery: message.delivery,
  }));

test("an ACP steer sent during one turn never cancels the next", async () => {
  const dir = tempDir();
  const { h, id, sessions } = await antigravity("hold-shell-natural", dir);
  try {
    const first = activeRootRun(h, id);
    if (!first) throw new Error("Expected the first prompt to be active");
    expect(queueMessage(h, id, "hold-for-steer:1")).toBe(true);
    expect(steer(h, id, "late steer")).toBe(true);
    // The steer waits on the shell A runs and kills nothing, beside the queued message.
    expect(h.engine.queue(id).pendingCount).toBe(2);
    expect(sessions[0]?.cancels).toEqual([]);

    // A ends by itself; the queued message starts the next turn and holds it.
    release(dir, 1);
    await expect.poll(() => activeRootRun(h, id)?.id).not.toBe(first.id);
    const second = activeRootRun(h, id);
    if (!second) throw new Error("Expected the queued prompt to be active, not cancelled");
    expect(h.store.snapshotThread(id).runs[first.id]).toMatchObject({ state: "completed" });
    // The steer aimed at A is handed back as the next message, not sent into B.
    await expect
      .poll(() => queuedTexts(h, id))
      .toEqual([{ text: "late steer", delivery: "queue" }]);
    expect(sessions[0]?.cancels).toEqual([]);
    expect(events(dir)).toEqual(["release"]);

    // B ends by itself, and the lost steer goes in once as its own message after it.
    release(dir, 2);
    await expect
      .poll(() => sessions[0]?.prompts, { timeout: 5000 })
      .toEqual(["hold-shell-natural", "hold-for-steer:1", "late steer"]);
    await h.engine.flush();
    expect(sessions[0]?.cancels).toEqual([]);
    expect(sessions[0]?.prompts.filter((prompt) => prompt === "late steer")).toHaveLength(1);
    // No cancel ever reached the double: neither turn was interrupted.
    expect(events(dir)).toEqual(["release", "release"]);
    expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, paused: false });
  } finally {
    if (activeRootRun(h, id)) h.command({ type: "thread.interrupt", threadId: id, cascade: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("choosing Steer on a queued message cancels the turn running now", async () => {
  const dir = tempDir();
  const { h, id, sessions } = await antigravity("hold-shell-natural", dir);
  try {
    expect(queueMessage(h, id, "hold-for-steer:1")).toBe(true);
    expect(queueMessage(h, id, "later steer")).toBe(true);
    release(dir, 1);
    const first = Object.values(h.store.snapshotThread(id).runs)[0];
    if (!first) throw new Error("Expected the first prompt to be recorded");
    await expect.poll(() => activeRootRun(h, id)?.id).not.toBe(first.id);
    const running = activeRootRun(h, id);
    if (!running) throw new Error("Expected the queued prompt to be active");

    const queue = h.engine.queue(id);
    const message = queue.messages.find(
      (entry) => entry.input[0]?.type === "text" && entry.input[0].text === "later steer",
    );
    if (!message) throw new Error("Expected the steer to still be queued");
    expect(
      h.command({
        type: "queue.edit",
        threadId: id,
        expectedRevision: queue.revision,
        messageId: message.id,
        input: message.input,
        delivery: "steer",
      }).ok,
    ).toBe(true);

    await expect
      .poll(() => sessions[0]?.prompts, { timeout: 5000 })
      .toEqual(["hold-shell-natural", "hold-for-steer:1", "later steer"]);
    await h.engine.flush();
    expect(sessions[0]?.cancels).toEqual(["root"]);
    expect(h.store.snapshotThread(id).runs[running.id]).toMatchObject({
      state: "interrupted",
      endedBy: "steer",
    });
    expect(sessions[0]?.prompts.filter((prompt) => prompt === "later steer")).toHaveLength(1);
    expect(events(dir)).toEqual(["release", "cancel"]);
    expect(h.engine.queue(id)).toMatchObject({ pendingCount: 0, paused: false });
  } finally {
    if (activeRootRun(h, id)) h.command({ type: "thread.interrupt", threadId: id, cascade: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a steer that lost its turn doesn't block a newer steer", async () => {
  const dir = tempDir();
  const { h, id, sessions } = await antigravity("hold-shell-natural", dir);
  try {
    expect(queueMessage(h, id, "hold-shell-for-steer")).toBe(true);
    expect(steer(h, id, "early steer")).toBe(true);
    const first = activeRootRun(h, id);
    if (!first) throw new Error("Expected the first prompt to be active");

    // A ends by itself; the queued turn starts and runs a command of its own.
    release(dir, 1);
    await expect.poll(() => activeRootRun(h, id)?.id).not.toBe(first.id);
    const second = activeRootRun(h, id);
    if (!second) throw new Error("Expected the queued prompt to be active");
    // The steer aimed at the finished turn leaves the lane even while the new turn's command
    // runs, so a newer steer is not stuck behind it.
    await expect
      .poll(() => queuedTexts(h, id))
      .toEqual([{ text: "early steer", delivery: "queue" }]);
    expect(sessions[0]?.cancels).toEqual([]);
    expect(events(dir)).toEqual(["release"]);

    // Free the new turn's command, then the person steers into that turn: one cancel.
    release(dir, 2);
    await expect
      .poll(() => toolCalls(h, id).every((item) => item.type !== "tool_call" || item.complete))
      .toBe(true);
    expect(steer(h, id, "stop now")).toBe(true);
    await expect.poll(() => sessions[0]?.cancels, { timeout: 5000 }).toEqual(["root"]);
    await expect
      .poll(() => sessions[0]?.prompts, { timeout: 5000 })
      .toEqual(["hold-shell-natural", "hold-shell-for-steer", "stop now", "early steer"]);
    await h.engine.flush();
    expect(h.store.snapshotThread(id).runs[second.id]).toMatchObject({
      state: "interrupted",
      endedBy: "steer",
    });
    // One cancel only: the lost steer stopped nothing, and both reached the agent once.
    expect(sessions[0]?.cancels).toEqual(["root"]);
    expect(events(dir)).toEqual(["release", "release", "cancel"]);
    expect(sessions[0]?.prompts.filter((prompt) => prompt === "stop now")).toHaveLength(1);
    expect(sessions[0]?.prompts.filter((prompt) => prompt === "early steer")).toHaveLength(1);
  } finally {
    if (activeRootRun(h, id)) h.command({ type: "thread.interrupt", threadId: id, cascade: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
