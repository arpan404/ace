import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, CommandId, ThreadId } from "@ace/protocol";
import { Store } from "@ace/daemon";
import { transitionHarness } from "./transition-test-support.ts";
import { createEngineThread } from "./create-thread.ts";
import { handleQueue } from "./queue-commands.ts";
import { EngineRepository } from "./repository.ts";
import { activeRootRun } from "./steer-selection.ts";
import { retireThreadIntents } from "./thread-liveness.ts";

type Harness = ReturnType<typeof transitionHarness>;

/** The root's turn is running `build` in the foreground. */
async function runningCommand(h: Harness): Promise<ThreadId> {
  const id = await h.create();
  h.held.add(id);
  h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "Start work" }] });
  await h.engine.flush();
  h.emit(id, {
    type: "item.upsert",
    agent: "root",
    item: "build",
    draft: {
      type: "tool_call",
      complete: false,
      call: { title: "Build", status: "running", detail: { kind: "shell", command: "build" } },
    },
  });
  await h.engine.flush();
  return id;
}

const agentMessage = (
  h: Harness,
  id: ThreadId,
  text: string,
  delivery: "steer" | "queue",
  commandId = `agent-${text.length}`,
) =>
  h.internalCommand(
    {
      type: "thread.send",
      threadId: id,
      input: [{ type: "text", text }],
      delivery,
      trigger: "parent_agent",
    },
    commandId,
  );

/** The person presses Steer on a waiting message. */
const steerIn = (h: Harness, id: ThreadId, messageId: string) => {
  const queue = h.engine.queue(id);
  const message = queue.messages.find((entry) => entry.id === messageId);
  if (!message) throw new Error("Not queued");
  return h.command({
    type: "queue.edit",
    threadId: id,
    expectedRevision: queue.revision,
    messageId: message.id,
    input: message.input,
    delivery: "steer",
  });
};

const texts = (h: Harness, from: number) => h.inputs.slice(from).map((input) => input.text);

test("an agent's steer reaches a Claude-like turn at once and leaves the running command alone", async () => {
  const h = transitionHarness({ steerTiming: "after_tool", backgroundTools: "moves" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(agentMessage(h, id, "Use the cached build", "steer").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([
      { text: "Use the cached build", delivery: "steer" },
    ]);
    expect(h.backgroundRequests).toEqual([]);
    expect(h.interrupts).toEqual([]);
    expect(h.engine.queue(id).messages).toEqual([]);
  } finally {
    await h.close();
  }
});

test("a steer on a provider that steers natively is admitted with no run of its own", async () => {
  // Claude reads a steer itself when the running command returns. Aiming one at a run would fence
  // what the provider handles alone: a lost target requeues it, an idle one is refused once
  // another turn begins. ace aims only sessions that steer by cancelling, as ACP does.
  const h = transitionHarness({ steerTiming: "after_tool" });
  try {
    const id = await runningCommand(h);
    expect(agentMessage(h, id, "Use the cached build", "steer", "native-steer").ok).toBe(true);
    await h.engine.flush();
    const row = h.store
      .statement("SELECT payload FROM intents WHERE command_id=?")
      .get("native-steer");
    if (!row) throw new Error("Expected the steer to be admitted");
    expect(Command.parse(JSON.parse(String(row.payload))).payload).not.toHaveProperty("runId");
    expect(h.inputs.filter((input) => input.text === "Use the cached build")).toMatchObject([
      { delivery: "steer" },
    ]);
  } finally {
    await h.close();
  }
});

test("a native steer goes in at once even when its recorded aim names a turn that ended", async () => {
  // The recorded aim exists for every steer, but only a session that steers by cancelling reads
  // it. A native steer must never be fenced by it: here the aim names a turn that never ran.
  const h = transitionHarness({ steerTiming: "after_tool", backgroundTools: "moves" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(agentMessage(h, id, "Use the cached build", "steer", "native-steer").ok).toBe(true);
    // Written between admission and the lanes: the steer lane runs once this stack unwinds.
    h.store
      .statement(
        "UPDATE engine_steer_aims SET run='lost-turn' WHERE intent_id=(SELECT id FROM intents WHERE command_id='native-steer')",
      )
      .run();
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([
      { text: "Use the cached build", delivery: "steer" },
    ]);
    expect(h.engine.queue(id).messages).toEqual([]);
    expect(h.errors).toEqual([]);
  } finally {
    await h.close();
  }
});

test("the person's Steer on an agent's queued message goes in as their own steer", async () => {
  const h = transitionHarness({ steerTiming: "after_tool", backgroundTools: "moves" });
  try {
    const id = await runningCommand(h);
    const before = h.inputs.length;
    expect(agentMessage(h, id, "Review the docs next", "queue", "agent-queued").ok).toBe(true);
    await h.engine.flush();
    expect(texts(h, before)).toEqual([]);
    expect(steerIn(h, id, "agent-queued").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.slice(before)).toMatchObject([
      { text: "Review the docs next", delivery: "steer" },
    ]);
    // Like a steer the person typed, it moves the running command out of its way.
    expect(h.backgroundRequests).toEqual([{ threadId: id, inputsBefore: before + 1 }]);
    expect(h.engine.queue(id).messages).toEqual([]);
    // The transcript still says an agent wrote it.
    expect(h.store.snapshotThread(id).items["input:agent-queued"]).toMatchObject({
      origin: { kind: "parent_agent" },
    });
  } finally {
    await h.close();
  }
});

test("a steer refused because the turn ended falls back to the queue, says so, and goes in once next", async () => {
  const h = transitionHarness();
  try {
    const id = await h.create();
    h.held.add(id);
    h.command({ type: "thread.send", threadId: id, input: [{ type: "text", text: "Start work" }] });
    await h.engine.flush();
    const before = h.inputs.length;
    h.refuseNextSteer();
    expect(
      h.command(
        {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "Try the other path" }],
          delivery: "steer",
        },
        "person-steer",
      ).ok,
    ).toBe(true);
    await h.engine.flush();
    expect(texts(h, before)).toEqual([]);
    // Back in the queue as the next message, marked as a steer that couldn't go in.
    expect(h.engine.queue(id)).toMatchObject({
      paused: false,
      messages: [{ id: "person-steer", delivery: "queue", fellBack: true }],
    });
    h.held.delete(id);
    h.emit(id, { type: "turn.ended", agent: "root", outcome: "completed" });
    await h.engine.flush();
    expect(texts(h, before)).toEqual(["Try the other path"]);
    expect(h.engine.queue(id).messages).toEqual([]);
  } finally {
    await h.close();
  }
});

test("an agent's steer waiting behind a command across a daemon restart is delivered exactly once", async () => {
  // This provider's steer would cut into the command, so ace itself holds the steer.
  const h = transitionHarness();
  try {
    const id = await runningCommand(h);
    expect(agentMessage(h, id, "Use the cached build", "steer").ok).toBe(true);
    await h.engine.flush();
    expect(h.engine.queue(id).messages).toHaveLength(1);
    const before = h.inputs.length;
    h.held.delete(id);
    await h.restart();
    await h.engine.flush();
    expect(
      h.command({
        type: "thread.resume",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    await h.engine.flush();
    await h.engine.flush();
    expect(texts(h, before).filter((text) => text === "Use the cached build")).toHaveLength(1);
    expect(h.engine.queue(id).messages).toEqual([]);
    await h.restart();
    await h.engine.flush();
    expect(h.inputs.filter((input) => input.text === "Use the cached build")).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("the person's choice to steer an agent's message survives a restart", async () => {
  const h = transitionHarness();
  try {
    const id = await runningCommand(h);
    expect(agentMessage(h, id, "Review the docs next", "queue", "agent-queued").ok).toBe(true);
    await h.engine.flush();
    // Steered in while the queue can't deliver: the restart below holds it.
    expect(steerIn(h, id, "agent-queued").ok).toBe(true);
    await h.engine.flush();
    expect(h.inputs.filter((input) => input.text === "Review the docs next")).toHaveLength(1);
    await h.restart();
    await h.engine.flush();
    expect(h.inputs.filter((input) => input.text === "Review the docs next")).toHaveLength(1);
    expect(h.engine.queue(id).messages).toEqual([]);
  } finally {
    await h.close();
  }
});

interface SteerThread {
  repo: EngineRepository;
  store: Store;
  id: ThreadId;
  /** The turn running while the queue commands below apply. */
  run: string;
  dependencies: Parameters<typeof handleQueue>[1];
}

/**
 * A thread with one turn running, driven by its queue commands alone. The lanes never run here, so
 * the stored intent and its aim are read exactly as the command left them.
 */
async function withSteerThread(take: (thread: SteerThread) => void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "ace-steer-aims-"));
  const store = new Store(join(home, "state.sqlite"));
  try {
    const repo = new EngineRepository(store);
    const id = ThreadId.parse("steer-aim-thread");
    createEngineThread(repo, {
      id,
      workspaceId: store.createWorkspace(home, "Fixture"),
      title: "Steer aim",
      selection: { provider: "codex", options: {} },
      cwd: home,
      at: 1,
      silenceMs: 100,
    });
    // A live session that steers by cancelling, as an ACP one does.
    repo.steersByCancel = () => true;
    repo.apply(
      id,
      [{ type: "turn.started", agent: "root", nativeTurnId: "b", trigger: "user" }],
      2,
    );
    const run = activeRootRun(repo, id);
    if (!run) throw new Error("Expected a running turn");
    take({
      repo,
      store,
      id,
      run,
      dependencies: {
        repo,
        clock: { now: () => 3, setTimer: () => () => {} },
        ports: {},
        sync: () => {},
        schedule: () => {},
        wake: () => {},
      },
    });
  } finally {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  }
}

test("a text-only edit never aims a steer at the turn running now", async () => {
  await withSteerThread(({ repo, id, dependencies }) => {
    const intent = repo.add(
      Command.parse({
        id: "opening-steer",
        deviceId: "device",
        payload: {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "late steer" }],
          delivery: "steer",
        },
      }),
      id,
    );
    // Admitted while the session was still opening: it names no turn, payload or aim.
    repo.steerAims.record(intent, null);
    expect(repo.pending.steerTarget(intent)).toBeUndefined();
    expect(
      handleQueue(
        Command.parse({
          id: "edit-steer",
          deviceId: "device",
          payload: {
            type: "queue.edit",
            threadId: id,
            expectedRevision: repo.queue.get(id).revision,
            messageId: "opening-steer",
            input: [{ type: "text", text: "late steer, edited" }],
          },
        }),
        dependencies,
      ),
    ).toMatchObject({ ok: true });
    // The edit changed the text only: it neither names the turn running now nor replaces the aim
    // recorded at admission, so the steer still goes back to the queue instead of cancelling it.
    expect(repo.pending.steerTarget(intent)).toBeUndefined();
    expect(repo.steerAims.aim(intent)).toBeNull();
    expect(repo.pending.delivery(id, CommandId.parse("opening-steer"))).toMatchObject({
      status: "pending",
      delivery: "steer",
    });
  });
});

test("a resent steer is aimed at the turn running when it goes back in", async () => {
  await withSteerThread(({ repo, id, run, dependencies }) => {
    const held = repo.add(
      Command.parse({
        id: "held-steer",
        deviceId: "device",
        payload: {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "steer once" }],
          delivery: "steer",
        },
      }),
      id,
    );
    repo.steerAims.record(held, null);
    repo.queue.uncertain(held);
    expect(
      handleQueue(
        Command.parse({
          id: "resend-steer",
          deviceId: "device",
          payload: {
            type: "queue.resend",
            threadId: id,
            expectedRevision: repo.queue.get(id).revision,
            messageId: "held-steer",
          },
        }),
        dependencies,
      ),
    ).toMatchObject({ ok: true });
    const replacement = [...repo.pending.headers(id)].find(
      (header) => header.commandId === "resend-steer",
    );
    if (!replacement) throw new Error("Expected the resent steer");
    // The replacement is a steer again, so it keeps the turn running as its aim, as a fresh one
    // does: a cancel-steered session cancels that turn, never a later one it never saw.
    expect(replacement.delivery).toBe("steer");
    expect(repo.steerAims.aim(replacement.id)).toBe(run);
  });
});

test("retiring a thread forgets the aim of an uncertain steer it never sent", async () => {
  await withSteerThread(({ repo, id }) => {
    const intent = repo.add(
      Command.parse({
        id: "uncertain-steer",
        deviceId: "device",
        payload: {
          type: "thread.send",
          threadId: id,
          input: [{ type: "text", text: "maybe sent" }],
          delivery: "steer",
        },
      }),
      id,
    );
    repo.steerAims.record(intent, null);
    repo.queue.uncertain(intent);
    retireThreadIntents(repo, id, 4, "Retired for thread deletion");
    // The intent is marked failed before its uncertainty is cleared, so its aim is pruned after,
    // as it is for any send that ends.
    expect(repo.pending.commandStatus(CommandId.parse("uncertain-steer"))).toBe("failed");
    expect(repo.steerAims.aim(intent)).toBeUndefined();
  });
});
