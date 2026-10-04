import { expect, test } from "vitest";
import { DelegationRequest } from "@ace/protocol";
import { applyDelivery } from "@ace/projection";
import { setup } from "./test-support.ts";

function card(h: ReturnType<typeof setup>, parent: import("@ace/protocol").ThreadId) {
  const item = h.store
    .readItemPage(parent, h.store.headSeq() + 1, 50)
    .items.find((entry) => entry.type === "delegation.started");
  if (item?.type !== "delegation.started") throw new Error("Missing inline delegation");
  return item;
}

test("a prepared delegation is visible before launch and its stable card follows human and failure states", async () => {
  const h = setup();
  const parent = await h.parent();
  const view = h.store.snapshotThread(parent.threadId);
  const child = h.service.prepare(
    parent,
    DelegationRequest.parse({
      requestId: "inline",
      provider: "claude",
      model: "chosen-model",
      role: "greeter",
      task: "Say hello",
    }),
  );
  const prepared = card(h, parent.threadId);
  expect(prepared).toMatchObject({
    childThreadId: child.childId,
    provider: "claude",
    model: "chosen-model",
    title: "greeter",
    role: "greeter",
    phase: "created",
    status: { state: "new" },
    complete: false,
  });
  expect(h.contexts.has(child.childId)).toBe(false);
  h.service.launch(child, "Say hello");
  await h.engine.flush();
  expect(card(h, parent.threadId)).toMatchObject({
    id: prepared.id,
    phase: "running",
    status: { state: "working" },
  });
  await h.emit(child.childId, {
    type: "interaction.opened",
    agent: "root",
    interaction: "question",
    blocking: true,
    request: {
      kind: "question",
      questions: [
        { id: "q", text: "Which greeting?", options: [], multiSelect: false, allowOther: true },
      ],
    },
  });
  expect(card(h, parent.threadId).status.state).toBe("needs_you");
  expect(h.store.getThread(parent.threadId)?.status.state).toBe("needs_you");
  await h.emit(
    child.childId,
    { type: "interaction.closed", interaction: "question", state: "cancelled" },
    {
      type: "turn.ended",
      agent: "root",
      outcome: "failed",
      error: { kind: "provider", message: "Model unavailable" },
    },
  );
  expect(card(h, parent.threadId)).toMatchObject({
    id: prepared.id,
    phase: "settled",
    status: { state: "failed" },
    complete: true,
    outcome: { outcome: "failed" },
  });
  const through = h.store.headSeq();
  expect(
    applyDelivery(view, {
      type: "events",
      afterSeq: view.seq,
      throughSeq: through,
      events: h.events.filter(
        (event) => event.threadId === parent.threadId && event.seq > view.seq,
      ),
    }).kind,
  ).toBe("applied");
  expect(view.items[prepared.id]).toMatchObject({
    type: "delegation.started",
    status: { state: "failed" },
  });
  const window = h.store.itemsWindow({
    threadId: parent.threadId,
    aroundSeq: through,
    before: 50,
    after: 0,
  });
  expect(window.items).toContainEqual(
    expect.objectContaining({ id: prepared.id, type: "delegation.started", phase: "settled" }),
  );
});

test("a delegated thread keeps its card live while background work survives a turn and reopens after completion", async () => {
  const h = setup();
  const parent = await h.parent();
  const child = h.delegate(parent, "background");
  await h.engine.flush();
  const id = card(h, parent.threadId).id;
  await h.emit(child.childId, {
    type: "background.started",
    agent: "root",
    task: "shell",
    kind: "shell",
    title: "Background check",
    stoppable: true,
  });
  await h.complete(child.childId, "Turn complete");
  expect(card(h, parent.threadId)).toMatchObject({
    id,
    phase: "running",
    complete: false,
    status: { state: "waiting", on: "background_task" },
  });
  expect(h.store.getThread(parent.threadId)?.status.state).not.toBe("done");
  await h.emit(child.childId, { type: "background.ended", task: "shell", status: "completed" });
  expect(card(h, parent.threadId)).toMatchObject({
    id,
    phase: "settled",
    outcome: { outcome: "completed" },
  });
  expect(h.service.message(parent, "followup", child.childId, "Continue", "queue").ok).toBe(true);
  expect(card(h, parent.threadId)).toMatchObject({
    id,
    phase: "running",
    generation: 1,
    complete: false,
    outcome: null,
  });
  await h.engine.flush();
  h.service.cancelDescendants(parent.threadId);
  await h.engine.flush();
  expect(card(h, parent.threadId)).toMatchObject({
    id,
    phase: "settled",
    complete: true,
    outcome: { outcome: "cancelled" },
  });
});
