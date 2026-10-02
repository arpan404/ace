import { Event, Item, Thread, type ItemsPage } from "@ace/protocol";
import { expect, it } from "vitest";
import { applyDelivery, applyItemsPage, createThreadView } from "./index.ts";

const thread = Thread.parse({
  id: "t",
  workspaceId: "w",
  title: "History",
  provider: "codex",
  status: { state: "done" },
  createdAt: 1,
  updatedAt: 1,
});
function message(id: string) {
  return Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "assistant",
    complete: false,
    createdAt: 1,
    parts: [{ type: "text", text: id }],
  });
}
function page(ids: string[], itemsBefore: number | null): ItemsPage {
  return { threadId: thread.id, items: ids.map(message), itemsBefore };
}

it("keeps older history cursors moving backward when partial replies repeat", () => {
  const view = createThreadView(thread, 100);
  view.itemsBefore = 30;
  const first = page(["middle"], 20);
  const second = page(["older"], 10);
  applyItemsPage(view, first);
  expect(view.itemsBefore).toBe(20);
  applyItemsPage(view, second);
  expect(view.itemsBefore).toBe(10);
  applyDelivery(view, {
    type: "events",
    subscriptionId: "s",
    afterSeq: 100,
    throughSeq: 101,
    events: [
      Event.parse({
        id: "live",
        seq: 101,
        at: 2,
        threadId: thread.id,
        payload: {
          type: "item.delta",
          itemId: message("middle").id,
          agentId: message("middle").agentId,
          field: "text",
          append: " live",
        },
      }),
    ],
  });
  applyItemsPage(view, first);
  expect(view.itemsBefore).toBe(10);
  expect(view.itemOrder).toEqual(["older", "middle"]);
  expect(view.items.middle).toMatchObject({ parts: [{ text: "middle live" }] });
  expect(first.items[0]).toMatchObject({ parts: [{ text: "middle" }] });
  expect(view.seq).toBe(101);
});

it("keeps completed history complete when an earlier partial page is reapplied", () => {
  const view = createThreadView(thread, 100);
  view.itemsBefore = 30;
  const first = page(["middle"], 20);
  const last = page(["oldest"], null);
  applyItemsPage(view, first);
  applyItemsPage(view, last);
  expect(view.itemsBefore).toBeNull();
  applyItemsPage(view, first);
  expect(view.itemsBefore).toBeNull();
  expect(view.itemOrder).toEqual(["oldest", "middle"]);
  expect(view.seq).toBe(100);
});
