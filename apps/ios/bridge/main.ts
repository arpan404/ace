import { host } from "./polyfills.ts";
import { ClientCore, type TransportEvents, type Lease, type ThreadSource } from "@ace/client";
import { z } from "zod";
import { CommandPayload, DeviceId, HostId } from "@ace/protocol";
import { call, scheduler } from "./host.ts";
import { PatchPump, followInbox, followThread } from "./patches.ts";

const Config = z.object({
  deviceId: DeviceId,
  hostId: HostId,
  itemLimit: z.number().int().min(200).max(2200),
});
const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), threadId: z.string().min(1) }),
  z.object({ type: z.literal("back") }),
  z.object({ type: z.literal("network"), online: z.boolean() }),
  z.object({ type: z.literal("command"), payload: CommandPayload }),
  z.object({ type: z.literal("retry") }),
]);
let client: ClientCore | undefined;
let lease: Lease<ThreadSource> | undefined;
let stopThread: (() => void) | undefined;
let epoch = 0;
let itemLimit = 200;
const pump = new PatchPump();
const sockets = new Map<string, TransportEvents>();
function error(): void {
  pump.put("error", () => ({
    type: "error",
    message: "Could not complete the request. Your saved sends remain available.",
  }));
}
async function start(json: string): Promise<void> {
  const config = Config.parse(JSON.parse(json));
  itemLimit = config.itemLimit;
  client = new ClientCore({
    deviceId: config.deviceId,
    expectedHostId: config.hostId,
    limits: { items: config.itemLimit, text: 8192 },
    transport: () => {
      const id = host.uuid();
      return {
        open(events) {
          sockets.set(id, events);
          host.socket(id, "open", "");
        },
        send(text) {
          host.socket(id, "send", text);
        },
        close() {
          sockets.delete(id);
          host.socket(id, "close", "");
        },
      };
    },
    credential: async () =>
      z
        .union([z.strictObject({ token: z.string() }), z.strictObject({ ticket: z.string() })])
        .parse(JSON.parse(await call("credential"))),
    storage: {
      load: async () => (await call("storage.load")) || null,
      save: async (value) => {
        await call("storage.save", value);
      },
      hostBinding: {
        load: async () => (await call("storage.host.load")) || null,
        save: async (value) => {
          await call("storage.host.save", value);
        },
      },
      records: {
        load: async () => z.array(z.string()).parse(JSON.parse(await call("storage.records"))),
        write: async (id, value) => {
          await call("storage.write", { id, value });
        },
      },
    },
    scheduler,
    id: () => host.uuid(),
    random: () => host.random(),
    now: () => host.now(),
  });
  const connection = client.connectionState();
  connection.subscribe(() =>
    pump.put("connection", () => ({ type: "connection", state: connection.getSnapshot() })),
  );
  followInbox(client.threads().store, pump);
  const owner = client;
  owner.observePendingSends((id) =>
    pump.put(`pending:${id}`, () => {
      const pending = owner.pendingSend(id);
      return {
        type: "pending",
        id,
        row: pending
          ? {
              id,
              threadId: pending.threadId,
              state: pending.state,
              waiting: pending.waiting,
              text: pending.payload.input
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
                .slice(0, 8192),
            }
          : null,
      };
    }),
  );
  await client.start();
}
async function hydrate(
  owner: ClientCore,
  store: ThreadSource,
  id: string,
  generation: number,
): Promise<void> {
  // Snapshots always cap at 200. Exercise the SDK's paged history admission and delta journal.
  await new Promise<void>((resolve) => {
    if (store.thread || store.error) {
      resolve();
      return;
    }
    const stop = store.observe(() => {
      if (store.thread || store.error) {
        stop();
        resolve();
      }
    });
  });
  while (store.itemsBefore != null && store.order.length < itemLimit) {
    if (generation !== epoch) return;
    await owner.loadOlder(id, Math.min(200, itemLimit - store.order.length));
  }
  if (generation === epoch)
    pump.put("thread:ready", () => ({
      type: "thread.ready",
      threadId: id,
      epoch: generation,
      count: store.order.length,
    }));
}
function action(json: string): void {
  try {
    const value = Action.parse(JSON.parse(json));
    if (!client) throw new Error("Client not started");
    switch (value.type) {
      case "open":
        stopThread?.();
        lease?.release();
        lease = client.thread(value.threadId);
        stopThread = followThread(lease.store, value.threadId, ++epoch, pump, itemLimit);
        if (itemLimit > 200) void hydrate(client, lease.store, value.threadId, epoch).catch(error);
        break;
      case "back":
        stopThread?.();
        lease?.release();
        lease = undefined;
        break;
      case "network":
        client.networkOnline(value.online);
        break;
      case "retry":
        client.reconnectNow();
        break;
      case "command":
        // The SDK owns persistence-before-send and first-answer-wins receipts.
        void client.command(value.payload).then(
          (result) =>
            pump.put("receipt", () => ({
              type: "receipt",
              id: result.commandId,
              ok: result.ok,
              message: result.ok ? "" : (result.error ?? "Request refused"),
            })),
          error,
        );
        break;
    }
  } catch {
    error();
  }
}
Object.assign(globalThis, {
  aceStart: (json: string) => {
    void start(json).catch(error);
  },
  aceAction: action,
  aceAck: () => pump.ack(),
  aceSocket: (id: string, type: string, value: string) => {
    const socket = sockets.get(id);
    if (!socket) return;
    if (type === "open") socket.open();
    else if (type === "message") socket.message(value);
    else if (type === "close") {
      sockets.delete(id);
      socket.close(Number(value));
    }
  },
});
