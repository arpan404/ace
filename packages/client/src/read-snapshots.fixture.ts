import { expect } from "vitest";
import { createThreadView } from "@ace/projection";
import { CoreClientMessage, DeviceId, Item, Thread, ThreadListView } from "@ace/protocol";
import { ClientCore, type ReadSnapshotStorage, type TransportEvents } from "./index.ts";

export const thread = Thread.parse({
  id: "thread",
  workspaceId: "project",
  provider: "codex",
  title: "Cached",
  status: { state: "working", agents: 1 },
  createdAt: 0,
  updatedAt: 0,
});
export function view(title = "Cached", seq = 10) {
  const result = createThreadView({ ...thread, title }, seq);
  const item = Item.parse({
    id: "answer",
    agentId: "root",
    type: "message",
    role: "assistant",
    createdAt: 1,
    complete: false,
    parts: [{ type: "text", text: "hello" }],
  });
  result.items = { answer: item };
  result.itemOrder = [item.id];
  result.itemSeqs = { answer: 1 };
  return result;
}
export const list = (title = "Cached") =>
  ThreadListView.parse({
    kind: "threads",
    seq: 10,
    threads: { thread: { ...thread, title } },
  });
export function memory() {
  const values = new Map<string, unknown>();
  const storage: ReadSnapshotStorage = {
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => {
      values.set(key, structuredClone(value));
    },
  };
  return { values, storage };
}
export function harness(storage: ReadSnapshotStorage, threads = 32) {
  let socket: TransportEvents | undefined;
  let nextId = 0;
  const sent: ReturnType<typeof CoreClientMessage.parse>[] = [];
  const scheduled = new Set<{ ms: number; callback: () => void }>();
  const client = new ClientCore({
    deviceId: DeviceId.parse("device"),
    readSnapshots: storage,
    storage: { load: async () => null, save: async () => {} },
    credential: async () => "a".repeat(64),
    random: () => 0.5,
    id: () => `id-${++nextId}`,
    limits: { threads },
    scheduler: {
      set(ms, callback) {
        const job = { ms, callback };
        scheduled.add(job);
        return () => {
          scheduled.delete(job);
        };
      },
    },
    transport: () => ({
      open(events) {
        socket = events;
        events.open();
      },
      send(text) {
        sent.push(CoreClientMessage.parse(JSON.parse(text)));
      },
      close() {},
    }),
  });
  const deliver = (message: unknown) => socket?.message(JSON.stringify(message));
  return {
    client,
    sent,
    deliver,
    async start() {
      await client.start();
      await expect.poll(() => sent.some((message) => message.type === "hello")).toBe(true);
      deliver({
        type: "welcome",
        hostId: "30f6c4b7-ee27-4793-8c80-7613f816a314",
        protocolVersion: 1,
        headSeq: 10,
      });
      await expect.poll(() => client.state).toBe("ready");
    },
    async reconnect(headSeq: number) {
      const hellos = sent.filter((message) => message.type === "hello").length;
      socket?.close(1006);
      client.reconnectNow();
      await expect
        .poll(() => sent.filter((message) => message.type === "hello").length)
        .toBe(hellos + 1);
      deliver({
        type: "welcome",
        hostId: "30f6c4b7-ee27-4793-8c80-7613f816a314",
        protocolVersion: 1,
        headSeq,
      });
      await expect.poll(() => client.state).toBe("ready");
    },
    wire(kind: "thread" | "threads") {
      const wire = sent.findLast(
        (message) => message.type === "subscribe" && message.scope.kind === kind,
      );
      if (!wire || wire.type !== "subscribe") throw new Error("No subscription");
      return wire;
    },
    flush() {
      for (const job of scheduled)
        if (job.ms === 1_000) {
          scheduled.delete(job);
          job.callback();
        }
    },
  };
}
