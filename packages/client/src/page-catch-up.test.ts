import { createThreadView } from "@ace/projection";
import { AgentId, Event, ItemId, Thread, type EventPayload, type Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { ThreadStore } from "./thread-store.ts";
import { defaultLimits } from "./types.ts";

/*
 * An older page is read on the daemon before some live events land. When it arrives the store
 * catches its bodies up on every event since its read, so it never installs a body older than
 * what the store already applied.
 */

const thread = Thread.parse({
  id: "thread",
  workspaceId: "workspace",
  provider: "codex",
  title: "Pages",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
  rootAgentId: "root",
});
const root = AgentId.parse("root");
const message = (id: string, role: "user" | "assistant", text: string): Item => ({
  type: "message",
  id: ItemId.parse(id),
  agentId: root,
  role,
  createdAt: 1,
  complete: true,
  synthetic: false,
  raw: [],
  parts: [{ type: "text", text }],
});

function opened() {
  const store = new ThreadStore(defaultLimits);
  const view = createThreadView(thread);
  view.seq = 10;
  const newest = message("newest", "assistant", "the newest reply");
  view.items = { newest };
  view.itemOrder = ["newest"];
  view.itemSeqs = { newest: 9 };
  view.itemsBefore = 9;
  store.snapshot(view);
  let seq = 10;
  const deliver = (payload: EventPayload) => {
    const afterSeq = seq;
    seq += 1;
    store.delivery({
      type: "events",
      subscriptionId: "thread",
      afterSeq,
      throughSeq: seq,
      events: [Event.parse({ id: `e${seq}`, threadId: thread.id, seq, at: 0, payload })],
    });
  };
  return { store, deliver };
}

test("an input admitted while an older page is out gets its native id on the page's copy", () => {
  const { store, deliver } = opened();
  // Only the admission: no update follows it to carry the native id.
  deliver({ type: "input.admitted", agentId: root, nativeInputId: "native-1", commandId: "c1" });
  store.page(
    {
      seq: 10,
      threadId: thread.id,
      items: [message("input:c1", "user", "the person's prompt")],
      itemSeqs: { "input:c1": 2 },
      itemsBefore: null,
    },
    9,
  );
  expect(store.item("input:c1")).toMatchObject({ nativeId: "native-1" });
  expect(store.order).toEqual(["input:c1", "newest"]);
});

test("an older item edited while its page is out shows the edit, not the page's copy", () => {
  const { store, deliver } = opened();
  deliver({ type: "item.updated", item: message("older", "assistant", "edited live") });
  store.page(
    {
      seq: 10,
      threadId: thread.id,
      items: [message("older", "assistant", "as the page read it")],
      itemSeqs: { older: 3 },
      itemsBefore: null,
    },
    9,
  );
  expect(store.item("older")).toMatchObject({ parts: [{ text: "edited live" }] });
});
