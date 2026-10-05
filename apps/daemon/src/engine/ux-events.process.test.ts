import { applyEvent, createThreadView } from "@ace/projection";
import { Store } from "@ace/daemon";
import { ThreadId } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { transitionHarness } from "./transition-test-support.ts";
import { harness, scriptFrames, start } from "./test-support.ts";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});
test("a provider handoff is a separate synthetic item before the person's next message", async () => {
  const h = transitionHarness();
  closes.push(h.close);
  const id = await h.create();
  h.command({
    type: "thread.switch",
    threadId: id,
    selection: { provider: "claude", model: "new-model" },
  });
  await h.engine.flush();
  const receipt = h.command({
    type: "thread.send",
    threadId: id,
    input: [{ type: "text", text: "my next message" }],
  });
  await h.engine.flush();
  const view = h.store.snapshotThread(id);
  const items = view.itemOrder.map((itemId) => view.items[itemId]);
  const handoff = items.find((item) => item?.type === "message" && item.origin?.kind === "handoff");
  const person = items.find((item) => item?.id === `input:${receipt.commandId}`);
  expect(handoff).toMatchObject({
    synthetic: true,
    origin: {
      kind: "handoff",
      from: { provider: "codex" },
      to: { provider: "claude", model: "new-model" },
      lossy: true,
    },
  });
  expect(person).toMatchObject({
    parts: [{ type: "text", text: "my next message" }],
    origin: { kind: "person" },
  });
  expect(items.indexOf(handoff)).toBeLessThan(items.indexOf(person));
});
test("structured terminal errors survive event replay and snapshots", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "turn.ended",
            agent: "root",
            outcome: "failed",
            error: { kind: "auth", message: "login expired" },
          }),
        ],
      },
    ],
    frames,
  );
  closes.push(h.close);
  const id = await h.create();
  const view = h.store.snapshotThread(id);
  expect(Object.values(view.runs)[0]).toMatchObject({
    state: "failed",
    error: { kind: "auth", code: "auth", title: "Not signed in to Codex", detail: "login expired" },
  });
  expect(h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "run.ended",
          error: expect.objectContaining({ code: "auth" }),
        }),
      }),
    ]),
  );
  const replayed = createThreadView(view.thread);
  for (const event of h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 })) {
    replayed.seq = event.seq - 1;
    applyEvent(replayed, event);
  }
  expect(Object.values(replayed.runs)[0]).toMatchObject({
    error: { code: "auth", detail: "login expired" },
  });
  const reopened = new Store(h.path);
  try {
    expect(Object.values(reopened.snapshotThread(id).runs)[0]).toMatchObject({
      error: { code: "auth", detail: "login expired" },
    });
  } finally {
    reopened.close();
  }
});

test("prepared handoffs publish their summary before the spawn input", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames);
  closes.push(h.close);
  const source = h.command({
    type: "thread.prepare",
    threadId: ThreadId.parse("source-thread"),
    workspaceId: h.workspace,
    provider: "codex",
    title: "Source",
  });
  expect(source.ok).toBe(true);
  const prepared = h.internalCommand(
    {
      type: "thread.prepare",
      threadId: ThreadId.parse("handoff-thread"),
      workspaceId: h.workspace,
      provider: "codex",
      title: "Delegate",
      titleSource: "agent",
      handoffFrom: ThreadId.parse("source-thread"),
    },
    "prepared-handoff",
  );
  if (!prepared.threadId) throw new Error("No thread");
  h.internalCommand(
    {
      type: "thread.send",
      threadId: prepared.threadId,
      input: [{ type: "text", text: "spawn task" }],
      origin: { kind: "spawn", parentThreadId: ThreadId.parse("source-thread") },
    },
    "spawn-handoff",
  );
  const view = h.store.snapshotThread(prepared.threadId);
  const ordered = view.itemOrder.map((id) => view.items[id]);
  const summary = ordered.find(
    (item) => item?.type === "message" && item.origin?.kind === "handoff",
  );
  const spawn = view.items["input:spawn-handoff"];
  expect(summary).toMatchObject({
    synthetic: true,
    origin: {
      kind: "handoff",
      threadIds: ["source-thread"],
      from: { provider: "codex" },
      to: { provider: "codex" },
      lossy: true,
    },
  });
  expect(spawn).toMatchObject({
    parts: [{ type: "text", text: "spawn task" }],
    origin: { kind: "spawn" },
  });
  expect(ordered.indexOf(summary)).toBeLessThan(ordered.indexOf(spawn));
});

test("send failures publish readable correlated notices with operation names in diagnostics", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames, {
    beforeSend: async () => {
      throw new Error("checkpoint failed");
    },
  });
  closes.push(h.close);
  const receipt = h.command(
    {
      type: "thread.create",
      workspaceId: h.workspace,
      provider: "codex",
      input: [{ type: "text", text: "task" }],
    },
    "device",
    "failure-command",
  );
  if (!receipt.threadId) throw new Error("No thread");
  await h.engine.flush();
  const notices = Object.values(h.store.snapshotThread(receipt.threadId).items).filter(
    (item) => item.type === "notice" && item.level === "error",
  );
  expect(notices).toEqual([
    expect.objectContaining({
      text: "Message not sent",
      code: "delivery_failed",
      title: "Not sent",
      commandId: "failure-command",
      detail: "thread.create: checkpoint failed",
    }),
  ]);
  expect(h.engine.queue(receipt.threadId).messages).toEqual([
    expect.objectContaining({ id: "failure-command", state: "queued" }),
  ]);
});
