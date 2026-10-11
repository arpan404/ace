import { ClientCore, type TransportEvents } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { browserClientOptions, localOutbox } from "./client.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (at: number) => [...values.keys()][at] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function client(store: ReturnType<typeof localOutbox>, token: string) {
  let socket: TransportEvents | undefined;
  const sent: unknown[] = [];
  let ids = 0;
  const core = new ClientCore({
    ...browserClientOptions({
      deviceId: "device",
      storage: store,
      credential: async () => token,
      transport: () => ({
        open(events) {
          socket = events;
        },
        send(text) {
          sent.push(JSON.parse(text));
        },
        close() {},
      }),
    }),
    scheduler: { set: () => () => {} },
    id: () => `id-${++ids}`,
  });
  const welcome = (hostId: string) =>
    socket?.message(JSON.stringify({ type: "welcome", hostId, protocolVersion: 1, headSeq: 0 }));
  return { core, sent, welcome };
}
for (const host of ["host-a", "host-b"]) {
  test(`a primary outbox reload ${host === "host-a" ? "replays on its original host after token renewal" : "never replays on a replacement daemon"}`, async () => {
    const disk = storage();
    const first = client(localOutbox("same-url-and-device", disk), "a".repeat(64));
    await first.core.start();
    first.welcome("host-a");
    first.core.networkOnline(false);
    await first.core.enqueue(
      {
        type: "thread.send",
        threadId: ThreadId.parse("thread"),
        input: [{ type: "text", text: "Only host A may see this" }],
      },
      "original-id",
    );
    await first.core.close();
    const next = client(localOutbox("same-url-and-device", disk), "b".repeat(64));
    await next.core.start();
    next.welcome(host);
    // Outbox settlement is a persistence barrier, not a timer-based observation.
    await next.core
      .enqueue({ type: "thread.archive", threadId: ThreadId.parse("other") }, "barrier")
      .catch(() => {});
    const commands = next.sent.filter(
      (value) =>
        typeof value === "object" && value !== null && "type" in value && value.type === "command",
    );
    if (host === "host-a")
      expect(commands).toContainEqual(
        expect.objectContaining({ command: expect.objectContaining({ id: "original-id" }) }),
      );
    else {
      expect(commands).toEqual([]);
      expect(next.core.state).toBe("fatal");
    }
    await next.core.close();
  });
}

test("legacy unbound pending work stays recoverable without replaying to the next welcome", async () => {
  const disk = storage();
  const legacy = JSON.stringify([
    {
      command: {
        id: "legacy",
        deviceId: "device",
        payload: { type: "thread.archive", threadId: "thread" },
      },
      state: "pending",
    },
  ]);
  disk.setItem("legacy-outbox", legacy);
  const next = client(localOutbox("legacy-outbox", disk), "a".repeat(64));
  await next.core.start().catch(() => {});
  next.welcome("host-b");
  expect(next.sent).toEqual([]);
  expect(await localOutbox("legacy-outbox", disk).records?.load()).toContainEqual(
    expect.stringContaining('"legacy"'),
  );
  await next.core.close();
});
