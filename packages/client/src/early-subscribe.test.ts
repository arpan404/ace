import { ClientMessage, DeviceId, ThreadView } from "@ace/protocol";
import { expect, test } from "vitest";
import { ClientCore, defaultLimits, type TransportEvents } from "./index.ts";

/** A client on manual time whose sockets open at once; each socket's sends are kept apart. */
function harness() {
  let now = 0;
  const timers = new Set<{ at: number; run(): void }>();
  const sockets: { events: TransportEvents; sent: ClientMessage[] }[] = [];
  let id = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("device"),
    transport: () => {
      const socket = {
        events: undefined as unknown as TransportEvents,
        sent: [] as ClientMessage[],
      };
      return {
        open(events) {
          socket.events = events;
          sockets.push(socket);
          events.open();
        },
        send(text) {
          for (const line of text.split("\n"))
            socket.sent.push(ClientMessage.parse(JSON.parse(line)));
        },
        close() {},
      };
    },
    credential: async () => "a".repeat(64),
    storage: { load: async () => null, save: async () => {} },
    scheduler: {
      set(delay, run) {
        const timer = { at: now + delay, run };
        timers.add(timer);
        return () => void timers.delete(timer);
      },
    },
    random: () => 0.5,
    id: () => `id-${++id}`,
    now: () => now,
    limits: defaultLimits,
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter((t) => t.at <= until).toSorted((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.delete(next);
      now = next.at;
      next.run();
      await settle();
    }
    now = until;
  };
  const socket = () => {
    const last = sockets.at(-1);
    if (!last) throw new Error("No socket");
    return last;
  };
  const deliver = (message: unknown) => socket().events.message(JSON.stringify(message));
  const welcome = (databaseId?: string) =>
    deliver({
      type: "welcome",
      hostId: "host",
      protocolVersion: 1,
      headSeq: 1,
      ...(databaseId ? { databaseId } : {}),
    });
  return { client, sockets, socket, deliver, welcome, settle, advance };
}

const threadSubscribes = (sent: readonly ClientMessage[]) =>
  sent.flatMap((message) =>
    message.type === "subscribe" && message.scope.kind === "thread" ? [message] : [],
  );
const listSubscribes = (sent: readonly ClientMessage[]) =>
  sent.filter((message) => message.type === "subscribe" && message.scope.kind === "threads");

function view(seq: number, title: string) {
  return ThreadView.parse({
    kind: "thread",
    seq,
    thread: {
      id: "thread",
      workspaceId: "workspace",
      provider: "codex",
      title,
      status: { state: "done" },
      createdAt: 0,
      updatedAt: 0,
    },
    agents: {},
    runs: {},
    items: {},
    itemOrder: [],
    interactions: {},
    backgroundTasks: {},
    usage: {},
    usageSnapshots: {},
    agentChildren: {},
  });
}

test("the open thread and the sidebar subscribe in the hello's flight, once", async () => {
  const h = harness();
  const thread = h.client.thread("thread");
  const sidebar = h.client.threads();
  await h.client.start();
  await h.settle();
  // Before any welcome: the hello, then both read subscribes, all in one flight.
  const before = h.socket().sent;
  expect(before[0]?.type).toBe("hello");
  expect(threadSubscribes(before)).toHaveLength(1);
  expect(listSubscribes(before)).toHaveLength(1);
  h.welcome("db-a");
  await h.settle();
  // The welcome sends neither again.
  expect(threadSubscribes(h.socket().sent)).toHaveLength(1);
  expect(listSubscribes(h.socket().sent)).toHaveLength(1);
  const [subscribe] = threadSubscribes(h.socket().sent);
  // The first content frame answers the subscribe sent with the hello.
  h.deliver({
    type: "snapshot",
    subscriptionId: subscribe?.subscriptionId,
    seq: 1,
    view: view(1, "Hello"),
  });
  expect(thread.store.thread?.title).toBe("Hello");
  thread.release();
  sidebar.release();
});

test("commands queued while connecting wait for the welcome", async () => {
  const h = harness();
  await h.client.start();
  await h.settle();
  await h.client.enqueue({ type: "thread.archive", threadId: "thread" }, "archive");
  await h.settle();
  expect(h.socket().sent.some((message) => message.type === "command")).toBe(false);
  h.welcome("db-a");
  await h.settle();
  expect(h.socket().sent.some((message) => message.type === "command")).toBe(true);
});

test("a welcome naming another database drops the early resume and shows nothing from it", async () => {
  const h = harness();
  const thread = h.client.thread("thread");
  await h.client.start();
  await h.settle();
  h.welcome("db-a");
  await h.settle();
  const [first] = threadSubscribes(h.socket().sent);
  h.deliver({
    type: "snapshot",
    subscriptionId: first?.subscriptionId,
    seq: 5,
    view: view(5, "A"),
  });
  expect(thread.store.thread?.title).toBe("A");
  // The socket drops; the next one resumes from seq 5 in the hello's flight, assuming db-a.
  h.socket().events.close(1006, "gone");
  await h.advance(defaultLimits.retryCapMs);
  const [early] = threadSubscribes(h.socket().sent);
  expect(early?.afterSeq).toBe(5);
  // The daemon was reset: its database is another one.
  h.welcome("db-b");
  await h.settle();
  const sent = h.socket().sent;
  expect(sent).toContainEqual({ type: "unsubscribe", subscriptionId: early?.subscriptionId });
  const again = threadSubscribes(sent).at(-1);
  expect(again?.subscriptionId).not.toBe(early?.subscriptionId);
  expect(again?.afterSeq).toBeUndefined();
  // A frame the daemon still sent for the dropped subscription is not shown.
  h.deliver({
    type: "snapshot",
    subscriptionId: early?.subscriptionId,
    seq: 6,
    view: view(6, "stale"),
  });
  expect(thread.store.thread?.title).toBe("A");
  h.deliver({
    type: "snapshot",
    subscriptionId: again?.subscriptionId,
    seq: 2,
    view: view(2, "B"),
  });
  expect(thread.store.thread?.title).toBe("B");
  thread.release();
});

test("a welcome naming the database the early resume assumed keeps it", async () => {
  const h = harness();
  const thread = h.client.thread("thread");
  await h.client.start();
  await h.settle();
  h.welcome("db-a");
  await h.settle();
  const [first] = threadSubscribes(h.socket().sent);
  h.deliver({
    type: "snapshot",
    subscriptionId: first?.subscriptionId,
    seq: 5,
    view: view(5, "A"),
  });
  h.socket().events.close(1006, "gone");
  await h.advance(defaultLimits.retryCapMs);
  h.welcome("db-a");
  await h.settle();
  const sent = h.socket().sent;
  expect(threadSubscribes(sent)).toHaveLength(1);
  expect(threadSubscribes(sent)[0]?.afterSeq).toBe(5);
  expect(sent.some((message) => message.type === "unsubscribe")).toBe(false);
  thread.release();
});
