import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, AgentItem, EventPayload, type Event, type ServerMessage } from "@ace/protocol";
import { afterEach, expect, test } from "vitest";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
const unpinned = { persist() {}, committed() {} };

function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-live-writes-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const errors: unknown[] = [];
  const open = () => new Store(join(home, "events.sqlite"), (error) => errors.push(error));
  let store = open();
  cleanup.push(() => void store.close());
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  store.appendEvents(thread.id, [
    {
      type: "agent.created",
      agent: Agent.parse({
        id: "root",
        threadId: thread.id,
        parentId: null,
        origin: "root",
        native: { provider: "codex" },
        fidelity: "full",
        cwd: "/repo",
        status: { state: "starting" },
        createdAt: 1,
      }),
    },
    {
      type: "item.created",
      item: AgentItem.parse({
        id: "answer",
        agentId: "root",
        type: "message",
        role: "assistant",
        complete: false,
        createdAt: 1,
        parts: [{ type: "text", text: "" }],
      }),
    },
  ]);
  const live: Event[] = [];
  store.subscribe((events) => live.push(...events));
  return {
    get store() {
      return store;
    },
    thread,
    errors,
    live,
    async reopen() {
      await store.close();
      store = open();
    },
  };
}
const delta = (append: string): EventPayload =>
  EventPayload.parse({
    type: "item.delta",
    itemId: "answer",
    agentId: "root",
    field: "text",
    append,
  });
function stream(store: Store, threadId: Event["threadId"], payloads: EventPayload[]): void {
  store.prepareLiveWrite(Buffer.byteLength(JSON.stringify(payloads)));
  store.bufferLiveWrite(threadId, payloads, 1000, unpinned);
}
function answerText(events: Event[]): string {
  return events
    .map((event) =>
      event.payload.type === "item.delta" && event.payload.itemId === "answer"
        ? event.payload.append
        : "",
    )
    .join("");
}
function snapshotText(store: Store, id: Event["threadId"]): string {
  const item = store.snapshotThread(id).items.answer;
  if (item?.type !== "message") throw new Error("Missing answer");
  return item.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

test.each<[string, EventPayload, object]>([
  [
    "root agent waiting on subagents",
    EventPayload.parse({
      type: "agent.status",
      agentId: "root",
      status: { state: "blocked", on: "subagents", refs: ["child"] },
    }),
    { waitingOn: 1 },
  ],
  [
    "thread starting work",
    { type: "thread.updated", status: { state: "working", agents: 1 } },
    { workingSince: 1000 },
  ],
])(
  "a streamed batch whose %s adds a live-metadata update commits, keeps the store writable and survives reopen",
  async (_name, payload, live) => {
    const state = setup();
    const first = state.store.headSeq() + 1;
    stream(state.store, state.thread.id, [delta("hello"), payload]);
    expect(state.errors).toEqual([]);
    expect(state.live.map((event) => event.payload.type)).toEqual([
      "item.delta",
      payload.type,
      "thread.client.updated",
    ]);
    state.store.appendEvents(state.thread.id, [{ type: "thread.updated", title: "Later write" }]);
    expect(state.store.getThread(state.thread.id)?.title).toBe("Later write");
    expect(snapshotText(state.store, state.thread.id)).toBe("hello");
    await state.reopen();
    const stored = state.store
      .readEvents({ afterSeq: first - 1, limit: 100 })
      .filter((event) => event.threadId === state.thread.id);
    expect(stored).toEqual(state.live);
    expect(state.store.getThread(state.thread.id)?.live).toMatchObject(live);
  },
);

test("deltas published before a held batch reach subscribers once and match the stored text", async () => {
  const state = setup();
  stream(state.store, state.thread.id, [delta("a")]);
  stream(state.store, state.thread.id, [delta("b")]);
  const cursors = state.live.map((event) => event.seq);
  stream(state.store, state.thread.id, [
    delta("c"),
    delta("d"),
    { type: "thread.updated", title: "Boundary" },
  ]);
  expect(state.errors).toEqual([]);
  expect(answerText(state.live)).toBe("abcd");
  // A client resuming at any delivered cursor converges on the same text.
  for (const cursor of cursors) {
    const messages: ServerMessage[] = [];
    const stop = subscribe(
      state.store,
      `resume-${cursor}`,
      { kind: "thread", threadId: state.thread.id },
      cursor,
      1000,
      (message) => messages.push(message),
    );
    stop();
    let resumed = answerText(state.live.filter((event) => event.seq <= cursor));
    for (const message of messages) {
      if (message.type === "snapshot") {
        const item = message.view.kind === "thread" ? message.view.items.answer : undefined;
        resumed =
          item?.type === "message" && item.parts[0]?.type === "text" ? item.parts[0].text : "";
      } else if (message.type === "events") resumed += answerText(message.events);
    }
    expect(resumed).toBe("abcd");
  }
  await state.reopen();
  expect(snapshotText(state.store, state.thread.id)).toBe("abcd");
});

test("a snapshot whose newest item exceeds the snapshot budget still shows that item", () => {
  const state = setup();
  const chunk = "x".repeat(64 * 1024);
  for (let index = 0; index < 20; index++)
    state.store.appendEvents(state.thread.id, [delta(chunk)]);
  const view = state.store.snapshotThread(state.thread.id);
  expect(view.itemOrder).toEqual(["answer"]);
  expect(view.itemsBefore).toBeNull();
  // Bounded preview: the head of the text plus the source a client pages the rest from.
  expect(view.items.answer).toMatchObject({
    parts: [{ type: "text", text: chunk.slice(0, 4096), source: expect.any(Object) }],
  });
});
