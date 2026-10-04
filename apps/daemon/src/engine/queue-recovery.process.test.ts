import { afterEach, expect, test } from "vitest";
import { Command, CommandId } from "@ace/protocol";
import {
  fixture,
  cleanupRecovery,
  text,
  restart,
  resume,
  sends,
  replaceProvider,
  crashCopy,
  dispatch,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end, task, until } from "./test-support.ts";

afterEach(cleanupRecovery);

test("editing attachments, moving and removing queued messages changes only the surviving ordered deliveries", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, task, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  const id = await h.create();
  const context = { mentions: [{ path: "old.txt" }], attachments: [{ sha256: "a".repeat(64) }] };
  h.command({ type: "thread.send", threadId: id, input: text("a"), context }, "phone", "a");
  h.command({ type: "thread.send", threadId: id, input: text("b") }, "desktop", "b");
  h.command({ type: "thread.send", threadId: id, input: text("c") }, "phone", "c");
  await h.engine.flush();
  const target = () => ({ threadId: id, expectedRevision: h.engine.queue(id).revision });
  expect(
    h.command({
      type: "queue.edit",
      ...target(),
      messageId: CommandId.parse("a"),
      input: text("edited"),
      context: { mentions: [], attachments: [{ sha256: "b".repeat(64) }] },
    }).ok,
  ).toBe(true);
  expect(h.engine.queue(id).messages[0]?.context?.attachments).toEqual([
    { sha256: "b".repeat(64) },
  ]);
  expect(
    h.command({ type: "queue.move", ...target(), messageId: CommandId.parse("c"), after: null }).ok,
  ).toBe(true);
  expect(h.command({ type: "queue.remove", ...target(), messageId: CommandId.parse("b") }).ok).toBe(
    true,
  );
  // Omitting context on replacement removes the attachments too.
  expect(
    h.command({
      type: "queue.edit",
      ...target(),
      messageId: CommandId.parse("a"),
      input: text("edited"),
    }).ok,
  ).toBe(true);
  expect(h.engine.queue(id).messages.map((message) => message.id)).toEqual(["c", "a"]);
  expect(h.engine.queue(id).messages[1]?.context).toBeUndefined();
  h.contexts[0]?.onFrame(
    frames.frame({ type: "background.ended", task: "shell", status: "completed" }),
  );
  await h.engine.flush();
  expect(
    h.adapter.commands.filter((command) => command.type === "send").map((command) => command.input),
  ).toEqual([text("first"), text("c"), text("edited")]);
  expect(h.engine.queue(id).messages).toEqual([]);
});

test("two devices racing the same revision get one winner and replaying its receipt cannot edit twice", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input: text("before") }, "device", "queued");
  await h.engine.flush();
  const revision = h.engine.queue(id).revision;
  const phone = await h.connect("phone"),
    desktop = await h.connect("desktop");
  const first = Command.parse({
    id: "edit-phone",
    deviceId: "phone",
    payload: {
      type: "queue.edit" as const,
      threadId: id,
      expectedRevision: revision,
      messageId: CommandId.parse("queued"),
      input: text("phone"),
    },
  });
  const second = Command.parse({
    id: "edit-desktop",
    deviceId: "desktop",
    payload: { ...first.payload, input: text("desktop") },
  });
  phone.send({ type: "command", command: first });
  desktop.send({ type: "command", command: second });
  const results = await Promise.all([
    until(phone, (message) => message.type === "commandResult" && message.commandId === first.id),
    until(
      desktop,
      (message) => message.type === "commandResult" && message.commandId === second.id,
    ),
  ]);
  const outcomes = results.map((message) =>
    message.type === "commandResult" ? message : undefined,
  );
  expect(outcomes.filter((result) => result?.ok)).toHaveLength(1);
  expect(outcomes.filter((result) => result?.error === "queue_conflict")).toHaveLength(1);
  const winner = outcomes[0]?.ok ? first : second;
  const before = h.engine.queue(id);
  const client = winner === first ? phone : desktop;
  client.send({ type: "command", command: winner });
  await until(
    client,
    (message) => message.type === "commandResult" && message.commandId === winner.id,
  );
  expect(h.engine.queue(id)).toEqual(before);
  client.send({ type: "queue.get", requestId: "read-queue", threadId: id });
  const response = await until(
    client,
    (message) => message.type === "queue.result" && message.requestId === "read-queue",
  );
  expect(response.type === "queue.result" && response.queue.messages[0]?.input).toEqual(
    winner.payload.type === "queue.edit" ? winner.payload.input : undefined,
  );
});

test("the configured steer default reaches a live capable provider while an explicit queue override waits", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, task, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { steer: true, preferences: { followUpBehavior: "steer" } },
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input: text("default") });
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toEqual({
    type: "send",
    input: text("default"),
    delivery: "steer",
  });
  h.command({ type: "thread.send", threadId: id, input: text("override"), delivery: "queue" });
  await h.engine.flush();
  expect(sends(h.adapter)).toHaveLength(2);
  expect(h.engine.queue(id).messages[0]?.delivery).toBe("queue");
});

test("claiming a message before provider startup makes a concurrent edit fail", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        entered.resolve();
        await release.promise;
        return h.adapter.openSession(ctx);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  h.command(
    { type: "thread.create", workspaceId: h.workspace, provider: "codex", input: text("claimed") },
    "device",
    "claimed",
  );
  await entered.promise;
  const id = h.store.listThreads()[0]?.id;
  if (!id) throw new Error("Missing thread");
  const result = h.command({
    type: "queue.edit",
    threadId: id,
    expectedRevision: h.engine.queue(id).revision,
    messageId: CommandId.parse("claimed"),
    input: text("too late"),
  });
  release.resolve();
  await h.engine.flush();
  expect(result.error).toBe("message_already_claimed");
  expect(sends(h.adapter)).toEqual([{ type: "send", input: text("claimed"), delivery: "queue" }]);
});

test.each([false, true])(
  "restart preserves reordering and auto-continue=%s controls whether the queue starts",
  async (auto) => {
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
    const id = await h.create();
    h.command({ type: "thread.send", threadId: id, input: text("a") }, "device", "a");
    h.command({ type: "thread.send", threadId: id, input: text("b") }, "device", "b");
    h.command({
      type: "queue.move",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      messageId: CommandId.parse("b"),
      after: null,
    });
    const replacement = replaceProvider(h, frames, [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const recovered = await restart(h, { preferences: { continueAfterRestart: auto } });
    if (!auto) {
      expect(sends(replacement)).toHaveLength(0);
      expect(recovered.queue(id)).toMatchObject({ paused: true, reason: "restart" });
      expect(resume(h, recovered, id).ok).toBe(true);
      await recovered.flush();
    }
    expect(h.contexts.at(-1)?.resume).toEqual({ nativeSessionId: "native-1" });
    const delivered = replacement.commands.filter((command) => command.type === "send");
    expect(delivered[0]?.input[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Background build"),
    });
    expect(delivered.slice(1).map((command) => command.input)).toEqual([text("b"), text("a")]);
    expect(
      Object.values(h.store.snapshotThread(id).runs).some((run) => run.trigger === "restart"),
    ).toBe(true);
  },
);

test("native restart continuation records lost shells monitors and subagents once", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            start,
            task,
            {
              type: "background.started",
              agent: "root",
              task: "monitor",
              kind: "monitor",
              title: "Watch tests",
              stoppable: true,
            },
            {
              type: "agent.seen",
              agent: "child",
              parent: "root",
              origin: "provider_subagent",
              fidelity: "full",
              native: { provider: "codex", nativeId: "child" },
              cwd: "/repo",
              name: "Research",
            },
            { type: "turn.started", agent: "child", trigger: "spawn" },
            end,
          ),
        ],
      },
    ],
    frames,
  );
  const id = await h.create();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  const recovered = await crashCopy(h);
  expect(sends(replacement)).toHaveLength(0);
  dispatch(recovered.store, recovered.engine, {
    type: "thread.resume",
    threadId: id,
    expectedRevision: recovered.engine.queue(id).revision,
  });
  await recovered.engine.flush();
  expect(recovered.store.getThread(id)?.status.state).toBe("done");
  const continuationItems = Object.values(recovered.store.snapshotThread(id).items).filter(item => item.type === "message" && item.origin?.kind === "restart");
  expect(continuationItems).toHaveLength(1);
  expect(continuationItems[0]).toMatchObject({synthetic:true,parts:[{type:"text",text:expect.stringContaining("shell: Background build")}]});
  expect(JSON.stringify(continuationItems[0])).toContain("monitor: Watch tests");
  expect(JSON.stringify(continuationItems[0])).toContain("subagent: Research");

  expect(sends(replacement)).toHaveLength(1);
  const continuation = replacement.commands.find((command) => command.type === "send");
  expect(continuation?.type === "send" ? continuation.input : []).toEqual([
    { type: "text", text: expect.stringContaining("shell: Background build") },
  ]);
  if (continuation?.type !== "send") throw new Error("Missing continuation");
  expect(continuation.input).toEqual([
    { type: "text", text: expect.stringContaining("monitor: Watch tests") },
  ]);
  expect(continuation.input).toEqual([
    { type: "text", text: expect.stringContaining("subagent: Research") },
  ]);
});

test("an unacknowledged send is never replayed automatically and must be removed before resuming", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send" }], frames);
  const id = await h.create();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  const recovered = await crashCopy(h, { preferences: { continueAfterRestart: true } });
  expect(recovered.engine.queue(id).messages[0]?.state).toBe("uncertain");
  expect(sends(replacement)).toHaveLength(0);
  expect(
    dispatch(recovered.store, recovered.engine, {
      type: "queue.resume",
      threadId: id,
      expectedRevision: recovered.engine.queue(id).revision,
    }).error,
  ).toBe("uncertain_delivery");
  expect(
    dispatch(
      recovered.store,
      recovered.engine,
      { type: "thread.send", threadId: id, input: text("following") },
      "following",
    ).ok,
  ).toBe(true);
  expect(
    dispatch(
      recovered.store,
      recovered.engine,
      {
        type: "queue.move",
        threadId: id,
        expectedRevision: recovered.engine.queue(id).revision,
        messageId: CommandId.parse("following"),
        after: null,
      },
      "move-following",
    ).error,
  ).toBe("uncertain_delivery");
  const message = recovered.engine.queue(id).messages[0];
  if (!message) throw new Error("Missing uncertain send");
  expect(
    dispatch(
      recovered.store,
      recovered.engine,
      {
        type: "queue.remove",
        threadId: id,
        expectedRevision: recovered.engine.queue(id).revision,
        messageId: message.id,
      },
      "remove",
    ).ok,
  ).toBe(true);
  expect(recovered.engine.queue(id).messages.map((queued) => queued.id)).toEqual(["following"]);
});
