import { afterEach, expect, test } from "vitest";
import { Command, type ThreadId } from "@ace/protocol";
import { Store, Engine } from "@ace/daemon";
import { harness, scriptFrames, start, end, question, task } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function track<T extends Awaited<ReturnType<typeof harness>>>(h: T): T {
  cleanups.push(h.close);
  return h;
}
const input = [{ type: "text" as const, text: "next" }];
function transcript(store: Store, id: ThreadId) {
  const view = store.snapshotThread(id);
  return view;
}

test("a rejected receipt rolls back creation and intent delivery and can be retried once", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames));
  const payload = {
    type: "thread.create" as const,
    workspaceId: h.workspace,
    provider: "codex" as const,
    input,
  };
  h.store.atomic((db) =>
    db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_receipts
    BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`),
  );
  expect(() => h.command(payload, "device", "retry-me")).toThrow("receipt failure");
  await h.engine.flush();
  expect(h.store.listThreads()).toEqual([]);
  expect(h.store.headSeq()).toBe(0);
  expect(h.adapter.commands).toEqual([]);
  h.store.atomic((db) => db.exec("DROP TRIGGER reject_receipt"));
  expect(h.command(payload, "device", "retry-me").ok).toBe(true);
  await h.engine.flush();
  expect(h.command(payload, "device", "retry-me").ok).toBe(true);
  await h.engine.flush();
  expect(h.store.listThreads()).toHaveLength(1);
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
});

test("steering reaches a capable provider while background work remains live", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        { on: "send", frames: [frames.frame(start, task, end)] },
        { on: "send", frames: [frames.frame(start, end)] },
      ],
      frames,
      { steer: true },
    ),
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "steer" });
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toEqual({ type: "send", input, delivery: "steer" });
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "background_task" });
});

test("unsupported steering stays queued until provider work finishes", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, task, end)] }], frames),
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "steer" });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "background_task" });
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider context");
  context.onFrame(frames.frame({ type: "background.ended", task: "shell", status: "completed" }));
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(2);
  expect(h.adapter.commands.at(-1)).toMatchObject({ delivery: "queue" });
  // Acknowledge the queued delivery and observe the final settled state.
  context.onFrame(frames.frame(start, end));
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("shutdown gracefully closes live sessions and refuses later commands", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  const id = await h.create();
  await h.engine.close();
  expect(h.adapter.commands.at(-1)).toEqual({ type: "close", reason: "shutdown" });
  expect(Object.values(transcript(h.store, id).runs).map((run) => run.state)).toEqual([
    "interrupted",
  ]);
  expect(h.command({ type: "thread.send", threadId: id, input, delivery: "queue" }).error).toBe(
    "daemon_shutting_down",
  );
});

test("an interaction withdrawn by the provider cannot receive a late device answer", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, question, end)] }], frames),
  );
  const id = await h.create();
  const interaction = Object.values(transcript(h.store, id).interactions)[0];
  if (!interaction) throw new Error("Missing interaction");
  expect(
    h.command({
      type: "interaction.resolve",
      interactionId: interaction.id,
      resolution: { kind: "approval", optionId: "yes" },
    }).error,
  ).toBe("already_resolved");
  await h.engine.flush();
  expect(h.adapter.commands.some((command) => command.type === "resolve")).toBe(false);
});

test("a committed unattempted send waits after restart and runs after explicit resume", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames));
  h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex", input });
  await h.engine.close();
  expect(h.adapter.commands).toEqual([]);
  const restartedStore = new Store(h.path);
  const recovered = new Engine(restartedStore, { registry: h.registry, clock: h.clock });
  try {
    await recovered.flush();
    const id = restartedStore.listThreads()[0]?.id;
    if (!id) throw new Error("Missing recovered thread");
    expect(recovered.queue(id).paused).toBe(true);
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(0);
    const resumeCommand = Command.parse({
      id: "resume-first",
      deviceId: "device",
      payload: {
        type: "queue.resume",
        threadId: id,
        expectedRevision: recovered.queue(id).revision,
      },
    });
    restartedStore.recordCommand(resumeCommand.id, resumeCommand.deviceId, () =>
      recovered.handler.handle(resumeCommand, restartedStore),
    );
    await recovered.flush();
    expect(restartedStore.getThread(id)?.status.state).toBe("done");
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  } finally {
    await recovered.close();
    restartedStore.close();
  }
});

test("an intent with uncertain provider delivery is reported after restart without replay", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames));
  const id = await h.create();
  await h.engine.close();
  h.store.atomic((db) => db.prepare("UPDATE intents SET status = 'running'").run());
  const restartedStore = new Store(h.path);
  const recovered = new Engine(restartedStore, { registry: h.registry, clock: h.clock });
  try {
    await recovered.flush();
    expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
    expect(
      Object.values(transcript(restartedStore, id).items).some(
        (item) => item.type === "notice" && item.text.includes("execution is uncertain"),
      ),
    ).toBe(true);
  } finally {
    await recovered.close();
    restartedStore.close();
  }
});

test("recovery uses the saved state from the same commit as the final turn events", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  const id = await h.create();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider context");
  context.onFrame(frames.frame(end));
  await h.engine.flush();
  const restartedStore = new Store(h.path);
  const recovered = new Engine(restartedStore, { registry: h.registry, clock: h.clock });
  try {
    await recovered.flush();
    expect(restartedStore.getThread(id)?.status.state).toBe("done");
    expect(Object.values(transcript(restartedStore, id).agents)).toHaveLength(1);
  } finally {
    await recovered.close();
    restartedStore.close();
  }
});

test("a queued send does not publish done while its provider has not acknowledged the turn", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, end)] }, { on: "send" }], frames),
  );
  const id = await h.create();
  const seq = h.store.headSeq();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  expect(
    h.store
      .readEvents({ afterSeq: seq, threadId: id, limit: 1000 })
      .some(
        (event) =>
          event.payload.type === "thread.updated" && event.payload.status?.state === "done",
      ),
  ).toBe(false);
});

test("cascade interrupt reaches descendants when the provider cannot cascade itself", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        {
          on: "send",
          frames: [
            frames.frame(
              start,
              {
                type: "agent.seen",
                agent: "child",
                parent: "root",
                origin: "provider_subagent",
                fidelity: "full",
                native: { provider: "codex", nativeId: "child-native" },
                cwd: "/repo",
              },
              { type: "turn.started", agent: "child", trigger: "spawn" },
            ),
          ],
        },
        { on: "interrupt" },
        { on: "interrupt" },
      ],
      frames,
    ),
  );
  const id = await h.create();
  h.command({ type: "thread.interrupt", threadId: id, cascade: true });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "interrupt")).toEqual([
    { type: "interrupt", target: { agent: "child", cascade: false } },
    { type: "interrupt", target: { cascade: true } },
  ]);
});

test("provider resolution echoes keep the winning device attribution", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        { on: "send", frames: [frames.frame(start, question)] },
        {
          on: "resolve",
          frames: [
            frames.frame({
              type: "interaction.closed",
              interaction: "approval",
              state: "resolved",
            }),
          ],
        },
      ],
      frames,
    ),
  );
  const id = await h.create();
  const interaction = Object.values(transcript(h.store, id).interactions)[0];
  if (!interaction) throw new Error("Missing interaction");
  h.command(
    {
      type: "interaction.resolve",
      interactionId: interaction.id,
      resolution: { kind: "approval", optionId: "yes" },
    },
    "phone",
  );
  await h.engine.flush();
  expect(transcript(h.store, id).interactions[interaction.id]).toMatchObject({
    state: "resolved",
    resolvedBy: "phone",
    resolution: { kind: "approval", optionId: "yes" },
  });
});

test("a silence deadline advances core even when the translator emits no timed facts", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  const id = await h.create();
  h.clock.advance(1100);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  h.clock.advance(1101);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("unresponsive");
});

test("a frame persistence failure stops the session and reports later intents instead of dropping them", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  const id = await h.create();
  h.store.atomic((db) =>
    db.exec(`CREATE TRIGGER reject_bad_frame BEFORE INSERT ON engine_state_records
    WHEN NEW.section = 'items' AND NEW.key = 'bad'
    BEGIN SELECT RAISE(ABORT, 'frame persistence failed'); END`),
  );
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider context");
  context.onFrame(
    frames.frame({
      type: "item.delta",
      agent: "root",
      item: "bad",
      field: "text",
      append: "lost frame",
    }),
  );
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("failed");
  // Void frame consumers above rely on canonical failure. ACK consumers still
  // receive a rejected commit, rather than a swallowed success after fencing.
  await expect(context.onFrame(frames.frame({ type: "signal", agent: "root" }))).rejects.toThrow(
    "Provider frame failed to commit",
  );
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  expect(
    Object.values(transcript(h.store, id).items).some(
      (item) =>
        item.type === "notice" && item.text.includes("Thread stopped after a persistence failure"),
    ),
  ).toBe(true);
});

test("shutdown closes a session while its send is still awaiting provider I/O", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "close" }], frames));
  const entered = Promise.withResolvers<void>();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        const session = await h.adapter.openSession(ctx);
        return {
          ...session,
          async send() {
            const stopped = new Promise<void>((resolve) =>
              ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
            entered.resolve();
            await stopped;
            throw new Error("provider send aborted by shutdown");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  h.command({ type: "thread.create", workspaceId: h.workspace, provider: "codex", input });
  await entered.promise;
  await h.engine.close();
  expect(h.adapter.commands).toEqual([{ type: "close", reason: "shutdown" }]);
});

test.each([true, false])(
  "a reused native interaction key does not inherit the previous answer when its next interaction is closed=%s",
  async (closeNext) => {
    const closed = {
      type: "interaction.closed" as const,
      interaction: "approval",
      state: "resolved" as const,
    };
    const frames = scriptFrames();
    const h = track(
      await harness(
        [
          { on: "send", frames: [frames.frame(start, question)] },
          {
            on: "resolve",
            frames: [frames.frame(closed, question, ...(closeNext ? [closed] : []))],
          },
        ],
        frames,
      ),
    );
    const id = await h.create();
    const first = Object.values(transcript(h.store, id).interactions)[0];
    if (!first) throw new Error("Missing interaction");
    h.command(
      {
        type: "interaction.resolve",
        interactionId: first.id,
        resolution: { kind: "approval", optionId: "yes" },
      },
      "phone",
    );
    await h.engine.flush();
    const interactions = Object.values(transcript(h.store, id).interactions);
    expect(interactions).toHaveLength(2);
    expect(interactions.find((interaction) => interaction.id === first.id)?.resolvedBy).toBe(
      "phone",
    );
    const next = interactions.find((interaction) => interaction.id !== first.id);
    expect(next?.resolvedBy).toBeUndefined();
    expect(next?.state).toBe(closeNext ? "resolved" : "pending");
  },
);
