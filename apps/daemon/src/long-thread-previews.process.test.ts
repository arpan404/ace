import { expect, test } from "vitest";
import { ItemId, Item } from "@ace/protocol";
import {
  storeFixture,
  start,
  end,
  turns,
  userMessage,
  agentMessage,
  root,
} from "./long-thread-test-support.ts";

// Mutations: retaining deleted initiating/latest text, choosing the wrong surviving
// message, or restoring deleted caches after restart. Not executed (tests run at merge).
test("turn previews fall back to surviving messages after deletion and remain correct after restart", async () => {
  const f = storeFixture();
  const initiating = userMessage("first-user", "Original request");
  f.store.appendEvents(f.thread.id, [{ type: "item.created", item: initiating }], 15);
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: Item.parse({ ...userMessage("second-user", "Surviving request"), runId: "first" }),
      },
      { type: "item.created", item: agentMessage("first-answer", "Surviving answer", "first") },
      {
        type: "item.delta",
        agentId: root,
        itemId: ItemId.parse("first-answer"),
        field: "text",
        append: " with streamed text",
      },
      { type: "item.created", item: agentMessage("last-answer", "Deleted answer", "first") },
    ],
    25,
  );
  end(f.store, f.thread, "first", 30);
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    initiatingMessagePreview: "Original request",
    latestAgentMessagePreview: "Deleted answer",
  });
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.deleted", itemId: initiating.id },
      { type: "item.deleted", itemId: ItemId.parse("last-answer") },
    ],
    40,
  );
  const remaining = {
    initiatingMessagePreview: "Surviving request",
    latestAgentMessagePreview: "Surviving answer with streamed text",
  };
  expect(turns(f.store, f.thread).turns[0]).toMatchObject(remaining);
  await f.restart();
  expect(turns(f.store, f.thread).turns[0]).toMatchObject(remaining);
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.deleted", itemId: ItemId.parse("second-user") },
      { type: "item.deleted", itemId: ItemId.parse("first-answer") },
    ],
    50,
  );
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    initiatingMessagePreview: "",
    latestAgentMessagePreview: "",
  });
  await f.restart();
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    initiatingMessagePreview: "",
    latestAgentMessagePreview: "",
  });
});

// Mutations: publishing preview changes outside the canonical transaction or keeping
// a mutable fallback cache after rollback. Not executed (tests run at merge).
test("rolled-back deletions preserve turn previews and subsequent committed deletions clear them", () => {
  const f = storeFixture();
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: userMessage("request", "Kept request") }],
    15,
  );
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [{ type: "item.created", item: agentMessage("answer", "Kept answer", "first") }],
    25,
  );
  end(f.store, f.thread, "first", 30);
  const before = turns(f.store, f.thread);
  const deletions = [
    { type: "item.deleted" as const, itemId: ItemId.parse("request") },
    { type: "item.deleted" as const, itemId: ItemId.parse("answer") },
  ];
  expect(() =>
    f.store.atomic(() => {
      f.store.appendEvents(f.thread.id, deletions, 40);
      throw new Error("Abort deletion");
    }),
  ).toThrow("Abort deletion");
  expect(turns(f.store, f.thread)).toEqual(before);
  f.store.appendEvents(f.thread.id, deletions, 50);
  expect(turns(f.store, f.thread).turns[0]).toMatchObject({
    initiatingMessagePreview: "",
    latestAgentMessagePreview: "",
  });
});

// Mutations: selecting the current ordinal instead of an existing item's original
// ordinal or clearing the current turn's previews. Not executed (tests run at merge).
test("late deletion changes only the original turn while the next root run is active", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: Item.parse({ ...userMessage("old-request", "Old request"), runId: "first" }),
      },
      { type: "item.created", item: agentMessage("old-answer", "Old answer", "first") },
    ],
    25,
  );
  end(f.store, f.thread, "first", 30);
  start(f.store, f.thread, "second", 40);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: Item.parse({ ...userMessage("current-request", "Current request"), runId: "second" }),
      },
      { type: "item.created", item: agentMessage("current-answer", "Current answer", "second") },
    ],
    45,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      { type: "item.deleted", itemId: ItemId.parse("old-request") },
      { type: "item.deleted", itemId: ItemId.parse("old-answer") },
    ],
    50,
  );
  const [oldTurn, currentTurn] = turns(f.store, f.thread).turns;
  expect(oldTurn).toMatchObject({
    ordinal: 1,
    initiatingMessagePreview: "",
    latestAgentMessagePreview: "",
    outcome: "completed",
  });
  expect(currentTurn).toMatchObject({
    ordinal: 2,
    initiatingMessagePreview: "Current request",
    latestAgentMessagePreview: "Current answer",
    outcome: "active",
  });
});
