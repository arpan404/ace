import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ServerMessage, type ThreadId } from "@ace/protocol";
import { createDevThread } from "./commands.ts";
import { Store } from "./store.ts";
import { subscribe } from "./subscription.ts";
import { WireEncoder } from "./wire-encoder.ts";
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
function reconnect(store: Store, threadId: ThreadId, afterSeq: number, replayLimit = 100) {
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
