import { ClientCore, ClientError, defaultLimits, type TransportEvents } from "./index.ts";
import { ClientMessage, DeviceId } from "@ace/protocol";
import { expect, test } from "vitest";

/*
 * `media.connect` through the client's own request path, as every client asks for its media
 * connection (ADR 0147 §4): the daemon's `media.connect.result` is its answer, granted or not.
 */

async function connected() {
  let socket: TransportEvents | undefined;
  const sent: unknown[] = [];
  let id = 0;
  const client = new ClientCore({
    deviceId: DeviceId.parse("device"),
    transport: () => ({
      open(events) {
        socket = events;
      },
      send(text) {
        sent.push(JSON.parse(text));
      },
      close() {},
    }),
    credential: async () => "a".repeat(64),
    storage: { load: async () => null, save: async () => {} },
    scheduler: { set: () => () => {} },
    random: () => 0.5,
    id: () => `id-${++id}`,
    limits: defaultLimits,
  });
  await client.start();
  const deliver = (message: unknown) => socket?.message(JSON.stringify(message));
  deliver({ type: "welcome", hostId: "host", protocolVersion: 1, headSeq: 1 });
  return { client, sent, deliver };
}

const answers = {
  granted: {
    ok: true,
    connection: "mc_aaaaaaaa",
    url: "wss://studio.local:4612/media",
    ticket: "A".repeat(43),
    expiresAt: 1,
  },
  refused: { ok: false, code: "unavailable", message: "ace-media is not running" },
};

for (const [name, result] of Object.entries(answers)) {
  test(`media.connect resolves with the daemon's ${name} answer`, async () => {
    const { client, sent, deliver } = await connected();
    const reply = client.request({ type: "media.connect" });
    const asked = () =>
      sent.find((message) => (message as { type?: string }).type === "media.connect");
    for (let tries = 0; tries < 200 && !asked(); tries++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const request = ClientMessage.parse(asked());
    expect(request.type).toBe("media.connect");
    const requestId = "requestId" in request ? request.requestId : "";
    deliver({ type: "media.connect.result", requestId, result });
    await expect(reply).resolves.toEqual({ type: "media.connect.result", requestId, result });
  });
}

test("a malformed media.connect answer is refused, never resolved", async () => {
  const { client, sent, deliver } = await connected();
  const reply = client.request({ type: "media.connect" });
  const asked = () =>
    sent.find((message) => (message as { type?: string }).type === "media.connect");
  for (let tries = 0; tries < 200 && !asked(); tries++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const request = ClientMessage.parse(asked());
  const requestId = "requestId" in request ? request.requestId : "";
  // Granted without its ticket or connection.
  deliver({ type: "media.connect.result", requestId, result: { ok: true, expiresAt: 1 } });
  // An unreadable frame breaks the connection, and the request ends with it.
  await expect(reply).rejects.toBeInstanceOf(ClientError);
});
