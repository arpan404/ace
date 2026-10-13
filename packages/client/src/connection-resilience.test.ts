import { ClientCore, defaultLimits, type Storage, type TransportEvents } from "./index.ts";
import { DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";

const device = DeviceId.parse("device");
const hostId = "30f6c4b7-ee27-4793-8c80-7613f816a314";

function harness(storage: Storage) {
  let socket: TransportEvents | undefined;
  const sent: { type: string; [key: string]: unknown }[] = [];
  let id = 0;
  const client = new ClientCore({
    deviceId: device,
    transport: () => ({
      open(events) {
        socket = events;
        events.open();
      },
      send(text) {
        sent.push(JSON.parse(text));
      },
      close() {},
    }),
    credential: async () => "a".repeat(64),
    storage,
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => `id-${++id}`,
    limits: defaultLimits,
  });
  const deliver = (message: unknown) => socket?.message(JSON.stringify(message));
  const welcome = async () => {
    // The hello goes out once the credential resolves.
    await Promise.resolve();
    await Promise.resolve();
    deliver({ type: "welcome", hostId, protocolVersion: 1, headSeq: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { client, sent, deliver, welcome };
}

const record = (commandId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    command: {
      id: commandId,
      deviceId: device,
      payload: { type: "thread.read", threadId: "thread", unread: false },
    },
    state: "pending",
    order: 1,
    ...extra,
  });

function recordStorage(saved: Map<string, string>, binding: string | null): Storage {
  let bound = binding;
  return {
    load: async () => null,
    save: async () => {},
    records: {
      load: async () => [...saved.values()],
      write: async (commandId, value) => {
        if (value === null) saved.delete(commandId);
        else saved.set(commandId, value);
      },
    },
    hostBinding: {
      load: async () => bound,
      save: async (next) => {
        bound = next;
      },
    },
  };
}

test("an error the daemon ties to no request leaves the connection up", async () => {
  const { client, deliver, welcome } = harness({ load: async () => null, save: async () => {} });
  await client.start();
  await welcome();
  expect(client.state).toBe("ready");
  // What a daemon whose notifications service is down answers `notification.preferences` with.
  deliver({
    type: "error",
    code: "notifications_unavailable",
    message: "Notifications unavailable",
  });
  expect(client.state).toBe("ready");
  expect(client.error).toBeUndefined();
});

test("saved work no verified daemon identity vouches for doesn't block connecting", async () => {
  // Outboxes from builds before host binding hold records without a host id, and no binding.
  const saved = new Map([["legacy:1", record("legacy:1")]]);
  const { client, sent, welcome } = harness(recordStorage(saved, null));
  await expect(client.start()).resolves.toBeUndefined();
  await welcome();
  expect(client.state).toBe("ready");
  // Never replayed to a daemon it can't be tied to, and never deleted.
  expect(sent.filter((message) => message.type === "command")).toEqual([]);
  expect(saved.has("legacy:1")).toBe(true);
});

test("an unreadable saved record is skipped while the rest of the outbox replays", async () => {
  const saved = new Map([
    ["broken", "{not json"],
    ["odd", JSON.stringify({ command: { id: "odd" }, state: "pending" })],
    ["good:1", record("good:1", { hostId })],
  ]);
  const { client, sent, welcome } = harness(recordStorage(saved, hostId));
  await expect(client.start()).resolves.toBeUndefined();
  await welcome();
  expect(client.state).toBe("ready");
  expect(
    sent.flatMap((message) =>
      message.type === "command" ? [(message.command as { id: string }).id] : [],
    ),
  ).toEqual(["good:1"]);
});
