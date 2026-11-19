import "./test-host.ts";
import { ThreadStore, defaultLimits } from "@ace/client";
import { applyDelivery, createThreadView } from "@ace/projection";
import { AgentId, EventId, ItemId, Thread, ThreadId, type EventPayload } from "@ace/protocol";
import { expect, test } from "vitest";
import type { Block } from "@ace/ui-core/transcript-blocks";
import { blockRow, followBlocks } from "./thread-blocks.ts";

const thread = Thread.parse({
  id: "blocks",
  workspaceId: "workspace",
  title: "blocks",
  provider: "codex",
  status: { state: "done", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
const asked = (id: string): EventPayload => ({
  type: "item.created",
  item: {
    type: "message",
    id: ItemId.parse(id),
    agentId: AgentId.parse("root"),
    role: "user",
    createdAt: 1,
    complete: true,
    synthetic: false,
    raw: [],
    parts: [{ type: "text", text: id }],
  },
});
/** A full snapshot holding only these messages from the person. */
function snapshotOf(...ids: string[]) {
  const view = createThreadView(thread);
  applyDelivery(view, {
    type: "events",
    subscriptionId: "blocks",
    afterSeq: 0,
    throughSeq: ids.length,
    events: ids.map((id, at) => ({
      seq: at + 1,
      id: EventId.parse(`event-${id}`),
      at: 0,
      threadId: thread.id,
      payload: asked(id),
    })),
  });
  return view;
}

test("a block a full snapshot discarded sends nothing when its item or the order changes later", () => {
  const store = new ThreadStore(defaultLimits);
  const sent: string[] = [];
  const blocks = followBlocks(store, (key, read) => {
    if (read()) sent.push(key);
  });
  const stop = store.observe(blocks.tap);
  store.snapshot(snapshotOf("gone"));
  expect(sent.some((key) => key.includes("gone"))).toBe(true);
  store.snapshot(snapshotOf("kept"));
  sent.length = 0;
  blocks.tap(new Set(["item:gone", "order"]));
  expect(sent.filter((key) => key.includes("gone"))).toEqual([]);
  stop();
});

/** A snapshot holding one receipt for a child launched before the transcript in view. */
function receiptOnly() {
  const view = createThreadView(thread);
  applyDelivery(view, {
    type: "events",
    subscriptionId: "blocks",
    afterSeq: 0,
    throughSeq: 1,
    events: [
      {
        seq: 1,
        id: EventId.parse("event-receipt"),
        at: 0,
        threadId: thread.id,
        payload: {
          type: "item.created",
          item: {
            type: "delegation.settled",
            id: ItemId.parse("receipt"),
            agentId: AgentId.parse("root"),
            createdAt: 1,
            complete: true,
            raw: [],
            origin: "ace",
            delivery: "tool",
            results: [
              {
                threadId: ThreadId.parse("thread-builder"),
                outcome: "completed",
                result: "Built it",
                truncated: false,
                before: null,
              },
            ],
          },
        },
      },
    ],
  });
  const store = new ThreadStore(defaultLimits);
  store.snapshot(view);
  return store;
}

// Mutation: merging a receipt's child at its delivered outcome, ignoring the thread list.
test.each(["working", "human"] as const)(
  "a finished turn's group never reads done while a child it was handed reads %s in the list",
  (state) => {
    const store = receiptOnly();
    const block = {
      kind: "subagents",
      key: "subagents:receipt",
      itemIds: [],
      receiptIds: ["receipt"],
    } satisfies Block;
    const settled = blockRow(store, block, 0, () => undefined);
    expect(settled.agents?.title).toBe("1 subagent ran");
    const row = blockRow(store, block, 0, (id) => (id === "thread-builder" ? state : undefined));
    expect(row.agents?.title).toBe("1 subagent");
    expect(row.agents?.token).not.toBe(settled.agents?.token);
  },
);
