import { afterEach, expect, test } from "vitest";
import { CommandId } from "@ace/protocol";
import {
  fixture,
  cleanupRecovery,
  text,
  restart,
  dispatch,
  sends,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end, task } from "./test-support.ts";
afterEach(cleanupRecovery);

test("queue pages bound large messages and reject a cursor after reordering", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
  const id = await h.create();
  for (let i = 0; i < 5; i++)
    h.command(
      { type: "thread.send", threadId: id, input: text("x".repeat(200000)) },
      "device",
      `large-${i}`,
    );
  await h.engine.flush();
  const page = h.engine.queuePage({ threadId: id, limit: 32 });
  expect(page.messages.map((message) => message.id)).toEqual(["large-0", "large-1"]);
  expect(page).toMatchObject({ total: 5, next: "large-1" });
  if (!page.next) throw new Error("Missing next cursor");
  const next = h.engine.queuePage({
    threadId: id,
    after: page.next,
    expectedRevision: page.revision,
    limit: 32,
  });
  expect(next.messages.map((message) => message.id)).toEqual(["large-2", "large-3"]);
  h.command({
    type: "queue.move",
    threadId: id,
    expectedRevision: page.revision,
    messageId: CommandId.parse("large-4"),
    after: null,
  });
  expect(() =>
    h.engine.queuePage({
      threadId: id,
      after: page.next ?? undefined,
      expectedRevision: page.revision,
      limit: 32,
    }),
  ).toThrow("queue_conflict");
});

test("editing and removing queued attachments changes durable blob retention across restart", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
  const id = await h.create();
  const hash = "a".repeat(64),
    replacement = "b".repeat(64);
  h.command(
    {
      type: "thread.send",
      threadId: id,
      input: text("attachment"),
      context: { mentions: [], attachments: [{ sha256: hash }] },
    },
    "device",
    "attachment",
  );
  await h.engine.flush();
  const recovered = await restart(h);
  expect(recovered.retainsAttachment(id, hash)).toBe(true);
  dispatch(
    h.store,
    recovered,
    {
      type: "queue.edit",
      threadId: id,
      expectedRevision: recovered.queue(id).revision,
      messageId: CommandId.parse("attachment"),
      input: text("new attachment"),
      context: { mentions: [], attachments: [{ sha256: replacement }] },
    },
    "edit-attachment",
  );
  expect(recovered.retainsAttachment(id, hash)).toBe(false);
  expect(recovered.retainsAttachment(id, replacement)).toBe(true);
  dispatch(
    h.store,
    recovered,
    {
      type: "queue.remove",
      threadId: id,
      expectedRevision: recovered.queue(id).revision,
      messageId: CommandId.parse("attachment"),
    },
    "remove-attachment",
  );
  expect(recovered.retainsAttachment(id, replacement)).toBe(false);
});

test("prepared context survives a child completion until the owning root turn settles", async () => {
  const { writeFile, access, rm } = await import("node:fs/promises");
  let inputPath = "";
  const released = Promise.withResolvers<void>();
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            {
              type: "agent.seen",
              agent: "child",
              parent: "root",
              origin: "provider_subagent",
              fidelity: "full",
              cwd: "/repo",
              native: { provider: "codex" },
            },
            { type: "turn.started", agent: "child", trigger: "spawn" },
            { type: "turn.ended", agent: "child", outcome: "completed" },
            start,
          ),
        ],
      },
    ],
    frames,
    {
      prepareInput: async (command) => {
        if (command.payload.type !== "thread.send") throw new Error("Expected send");
        await writeFile(inputPath, "provider context");
        return {
          input: [...command.payload.input, { type: "file", path: inputPath }],
          release: () => {
            void rm(inputPath).then(() => released.resolve(), released.reject);
          },
        };
      },
    },
  );
  inputPath = `${h.home}/input.txt`;
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: text("inspect"),
    context: { mentions: [{ path: "input.txt" }], attachments: [] },
  });
  await h.engine.flush();
  await expect(access(inputPath)).resolves.toBeUndefined();
  h.contexts[0]?.onFrame(frames.frame(end));
  await h.engine.flush();
  // Await the same filesystem operation; no timer is used for synchronisation.
  await released.promise;
  await expect(access(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(sends(h.adapter)[0]).toMatchObject({
    input: [...text("inspect"), { type: "file", path: inputPath }],
  });
});

test("a send failure before acknowledgement remains visible for review instead of losing the message", async () => {
  const frames = scriptFrames();
  const h = await fixture([], frames);
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        const session = await h.adapter.openSession(ctx);
        return {
          ...session,
          async send() {
            throw new Error("Lost delivery acknowledgement");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: text("keep this"),
  });
  await h.engine.flush();
  const id = h.store.listThreads()[0]?.id;
  if (!id) throw new Error("Missing thread");
  expect(h.engine.queue(id)).toMatchObject({
    paused: true,
    reason: "uncertain",
    messages: [{ input: text("keep this"), state: "uncertain" }],
  });
});

test("missing context preparation holds the complete message instead of sending text without attachments", async () => {
  const frames = scriptFrames();
  const h = await fixture([], frames);
  const context = { mentions: [], attachments: [{ sha256: "a".repeat(64) }] };
  h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    input: text("read the attachment"),
    context,
  });
  await h.engine.flush();
  const id = h.store.listThreads()[0]?.id;
  if (!id) throw new Error("Missing thread");
  expect(sends(h.adapter)).toHaveLength(0);
  expect(h.engine.queue(id)).toMatchObject({
    paused: true,
    reason: "uncertain",
    messages: [{ input: text("read the attachment"), context, state: "uncertain" }],
  });
  expect(
    Object.values(h.store.snapshotThread(id).items).some(
      (item) => item.type === "notice" && item.text.includes("Context preparation is unavailable"),
    ),
  ).toBe(true);
});

test("a native queue draining wakes the server queue even while the visible waiting status stays the same", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      {
        on: "send",
        frames: [frames.frame(start, end, { type: "queue.changed", source: "provider", count: 1 })],
      },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input: text("after native") });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  expect(sends(h.adapter)).toHaveLength(1);
  h.contexts[0]?.onFrame(frames.frame({ type: "queue.changed", source: "provider", count: 0 }));
  await h.engine.flush();
  expect(sends(h.adapter)).toHaveLength(2);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("queue admission rejects overflow without removing or changing the accepted messages", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
  const id = await h.create();
  for (let i = 0; i < 256; i++)
    expect(
      h.command(
        { type: "thread.send", threadId: id, input: text(`queued ${i}`) },
        "device",
        `message-${i}`,
      ).ok,
    ).toBe(true);
  expect(h.command({ type: "thread.send", threadId: id, input: text("overflow") }).error).toBe(
    "queue_capacity_exceeded",
  );
  expect(
    h.command({ type: "thread.send", threadId: id, input: text("x".repeat(256 * 1024)) }).error,
  ).toBe("message_too_large");
  await h.engine.flush();
  const queue = h.engine.queue(id);
  expect(queue.messages).toHaveLength(256);
  expect(queue.messages[0]?.input).toEqual(text("queued 0"));
  expect(queue.messages.at(-1)?.input).toEqual(text("queued 255"));
});

test("restart auto-continuation retries after capacity becomes available instead of stranding the next thread", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, task, end)] }], frames);
  const first = await h.create();
  expect(
    h.command({
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: text("second"),
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  const second = h.store.listThreads().find((thread) => thread.id !== first)?.id;
  if (!second) throw new Error("Missing second thread");
  const { replaceProvider } = await import("./recovery-test-support.ts");
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  const recovered = await restart(h, {
    preferences: { continueAfterRestart: true },
    limits: { maxActiveThreads: 1 },
    idleMs: 0,
  });
  expect(sends(replacement)).toHaveLength(1);
  expect(
    [recovered.queue(first), recovered.queue(second)].filter((queue) => queue.resumeAt === 2000),
  ).toHaveLength(1);
  h.clock.advance(1000);
  await recovered.flush();
  h.clock.advance(2000);
  await recovered.flush();
  expect(sends(replacement)).toHaveLength(2);
  expect(h.store.getThread(first)?.status.state).toBe("done");
  expect(h.store.getThread(second)?.status.state).toBe("done");
});
