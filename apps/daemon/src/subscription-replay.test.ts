import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ServerMessage, type ThreadId } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";
import { WireEncoder } from "./wire-encoder.ts";
import type { SnapshotTail } from "./thread-reads.ts";
import { message } from "./payload-test-support.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-subscription-replay-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(() => store.close());
  const workspace = store.createWorkspace("/repo", "Repo", 1);
  return { store, a: createDevThread(store, workspace), b: createDevThread(store, workspace) };
}
let subscriptions = 0;
/** What a client reads from the wire after reconnecting at `afterSeq`. */
function reconnect(
  store: Store,
  threadId: ThreadId,
  afterSeq: number,
  replayLimit = 100,
  tail?: SnapshotTail,
) {
  const encoder = new WireEncoder();
  const wire: ServerMessage[] = [];
  const stop = subscribe(
    store,
    `s${++subscriptions}`,
    { kind: "thread", threadId },
    afterSeq,
    replayLimit,
    (sent) => wire.push(ServerMessage.parse(JSON.parse(encoder.encode(sent)))),
    250,
    () => () => {},
    false,
    encoder,
    undefined,
    tail,
  );
  cleanup.push(stop);
  return wire;
}

it("a thread whose missed events pass the replay limit gets a snapshot", () => {
  const { store, a, b } = setup();
  const cursor = store.headSeq();
  for (let index = 0; index < 4; index++)
    store.appendEvents(a.id, [{ type: "item.created", item: message(`a${index}`) }]);
  // Other threads' events never count toward a thread's limit.
  for (let index = 0; index < 6; index++)
    store.appendEvents(b.id, [{ type: "item.created", item: message(`b${index}`) }]);
  const over = reconnect(store, a.id, cursor, 3);
  expect(over.map((sent) => sent.type)).toEqual(["snapshot"]);
  const snapshot = over[0];
  if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "thread") throw new Error("No view");
  expect(snapshot.seq).toBe(store.headSeq());
  expect(snapshot.view.itemOrder).toEqual(["a0", "a1", "a2", "a3"]);
  const within = reconnect(store, a.id, cursor, 4);
  expect(within.map((sent) => sent.type)).toEqual(["events"]);
  const events = within[0];
  if (events?.type !== "events") throw new Error("No events");
  expect(events.events).toHaveLength(4);
  expect(events.throughSeq).toBe(store.headSeq());
});

/** One long streamed turn: a reply built from `deltas` text deltas, then completed. */
function streamTurn(store: Store, threadId: ThreadId, id: string, deltas: number) {
  const reply = { ...message(id, ""), complete: false };
  store.appendEvents(threadId, [{ type: "item.created", item: reply }]);
  for (let index = 0; index < deltas; index += 50)
    store.appendEvents(
      threadId,
      Array.from({ length: Math.min(50, deltas - index) }, () => ({
        type: "item.delta" as const,
        itemId: reply.id,
        agentId: reply.agentId,
        field: "text" as const,
        append: "streamed words ",
      })),
    );
  store.appendEvents(threadId, [
    { type: "item.updated", item: { ...message(id, "streamed words ".repeat(deltas)) } },
  ]);
}
const bytes = (wire: ServerMessage[]) =>
  wire.reduce((total, sent) => total + Buffer.byteLength(JSON.stringify(sent)), 0);

it("a resume after a long streamed turn costs no more than a snapshot and shows the same thread", () => {
  const { store, a } = setup();
  for (let index = 0; index < 20; index++)
    store.appendEvents(a.id, [{ type: "item.created", item: message(`old${index}`) }]);
  const cursor = store.headSeq();
  streamTurn(store, a.id, "long", 4000);
  const resumed = reconnect(store, a.id, cursor, 5000);
  const fresh = reconnect(store, a.id, store.headSeq() + 1, 5000);
  expect(fresh.map((sent) => sent.type)).toEqual(["snapshot"]);
  expect(bytes(resumed)).toBeLessThanOrEqual(bytes(fresh));
  const [snapshot] = resumed;
  if (snapshot?.type !== "snapshot" || snapshot.view.kind !== "thread") throw new Error("No view");
  const [expected] = fresh;
  if (expected?.type !== "snapshot") throw new Error("No view");
  expect(snapshot).toEqual({ ...expected, subscriptionId: snapshot.subscriptionId });
});

it("a short resume still replays its events", () => {
  const { store, a } = setup();
  for (let index = 0; index < 20; index++)
    store.appendEvents(a.id, [{ type: "item.created", item: message(`old${index}`) }]);
  const cursor = store.headSeq();
  streamTurn(store, a.id, "short", 30);
  expect(reconnect(store, a.id, cursor, 5000).map((sent) => sent.type)).toEqual(["events"]);
});

it("a resume whose small snapshot would not reach the cursor replays instead", () => {
  const { store, a } = setup();
  for (let index = 0; index < 20; index++)
    store.appendEvents(a.id, [{ type: "item.created", item: message(`old${index}`) }]);
  const cursor = store.headSeq();
  for (let index = 0; index < 8; index++) streamTurn(store, a.id, `new${index}`, 200);
  const tail = { items: 3, bytes: 64 * 1024 };
  // Answered by snapshot, the held items before the cursor would be dropped and read again.
  expect(reconnect(store, a.id, cursor, 5000, tail).map((sent) => sent.type)).toContain("events");
  // A snapshot that holds everything after the cursor is still preferred.
  expect(reconnect(store, a.id, cursor, 5000).map((sent) => sent.type)).toEqual(["snapshot"]);
});

it.each([
  ["deleted", (id: string) => ({ type: "item.deleted" as const, itemId: message(id).id })],
  ["edited", (id: string) => ({ type: "item.updated" as const, item: message(id, "edited") })],
])(
  "a resume where an item older than the snapshot was %s replays, so the change arrives",
  (_change, change) => {
    const { store, a } = setup();
    for (let index = 0; index < 40; index++)
      store.appendEvents(a.id, [{ type: "item.created", item: message(`old${index}`) }]);
    const cursor = store.headSeq();
    // While the client is away, an item older than any small snapshot holds changes.
    store.appendEvents(a.id, [change("old0")]);
    streamTurn(store, a.id, "long", 4000);
    const wire = reconnect(store, a.id, cursor, 5000, { items: 30, bytes: 64 * 1024 });
    const delivered = wire.flatMap((sent) => (sent.type === "events" ? sent.events : []));
    expect(
      delivered.some(
        (event) =>
          (event.payload.type === "item.deleted" && event.payload.itemId === "old0") ||
          (event.payload.type === "item.updated" && event.payload.item.id === "old0"),
      ),
    ).toBe(true);
  },
);
