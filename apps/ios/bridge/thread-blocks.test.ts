// oxlint-disable-next-line import/no-unassigned-import -- Install the test host before the bridge reads it.
import "./test-host.ts";
import { ThreadStore, defaultLimits } from "@ace/client";
import { applyDelivery, createThreadView } from "@ace/projection";
import { AgentId, EventId, ItemId, Thread, type EventPayload } from "@ace/protocol";
import { expect, test } from "vitest";
import { followBlocks } from "./thread-blocks.ts";

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
