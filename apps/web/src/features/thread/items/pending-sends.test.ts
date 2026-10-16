import { defaultLimits, ThreadStore, type PendingSend } from "@ace/client";
import { createThreadView } from "@ace/projection";
import { Event, Item, Thread } from "@ace/protocol";
import { expect, test } from "vitest";
import { blockItems, buildBlocks } from "../transcript/blocks.ts";
import { withLocalSends } from "./pending-sends.ts";

test.each(["accepted", "delivered"] as const)(
  "a %s prompt keeps its place when live output pushes it outside the loaded window",
  (state) => {
    const store = new ThreadStore({ ...defaultLimits, items: 3 });
    const thread = Thread.parse({
      id: "thread",
      workspaceId: "workspace",
      provider: "codex",
      title: "Live prompt",
      status: { state: "working", agents: 1 },
      createdAt: 0,
      updatedAt: 0,
    });
    store.snapshot(createThreadView(thread));
    const send: PendingSend = {
      commandId: "original",
      itemId: "input:original",
      threadId: thread.id,
      state,
      waiting: false,
      payload: {
        type: "thread.send",
        threadId: thread.id,
        input: [{ type: "text", text: "Original prompt" }],
      },
    };
    const local = {
      pending: [send],
      staged: [],
      queued: new Set<string>(),
      dismissed: new Set<string>(),
      failures: new Map<string, string>(),
    };
    const rows = () =>
      withLocalSends(
        buildBlocks({ order: store.order, item: (id) => store.item(id), background: new Map() }),
        local,
        blockItems,
      ).flatMap(blockItems);
    const append = (seq: number, id: string, role: "user" | "assistant") => {
      store.delivery({
        type: "events",
        subscriptionId: "subscription",
        afterSeq: seq - 1,
        throughSeq: seq,
        events: [
          Event.parse({
            id: `event-${seq}`,
            seq,
            at: seq,
            threadId: thread.id,
            payload: {
              type: "item.created",
              item: Item.parse({
                id,
                agentId: "root",
                type: "message",
                role,
                createdAt: seq,
                complete: true,
                parts: [{ type: "text", text: id }],
              }),
            },
          }),
        ],
      });
    };
    append(1, send.itemId, "user");
    expect(rows()).toEqual([send.itemId]);
    for (let seq = 2; seq <= 4; seq++) append(seq, `output-${seq}`, "assistant");
    expect(store.item(send.itemId)).toBeUndefined();
    expect(rows()).toEqual(
      state === "delivered"
        ? ["output-2", "output-3", "output-4"]
        : ["output-2", "output-3", "output-4", send.itemId],
    );
  },
);
