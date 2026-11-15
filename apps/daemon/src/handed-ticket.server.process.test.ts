import { once } from "node:events";
import { expect, onTestFinished, test } from "vitest";
import { DeviceId, SocketTicket, type ServerMessage } from "@ace/protocol";
import { Client, fixture, token } from "./socket-test-support.ts";

/** The ticket a welcome handed over. */
function handed(message: ServerMessage) {
  if (message.type !== "welcome" || !message.ticket) throw new Error("No ticket handed over");
  return message.ticket;
}

// One real socket per connect, through the daemon's own ticket exchange and welcome.
async function setup() {
  const f = await fixture();
  onTestFinished(() => f.close());
  const phone = f.store.devices.create("Phone", ["projects"], 1);
  const exchanged = async () => {
    const response = await fetch(`${f.server.httpUrl}/v1/tickets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${phone.token}` },
    });
    return SocketTicket.parse(await response.json()).ticket;
  };
  /** Say hello with `ticket` and return the daemon's first answer. */
  const hello = async (ticket: string, nextTicket = true): Promise<ServerMessage> => {
    const client = new Client(f.server.url);
    onTestFinished(() => client.close());
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(phone.device.id),
      ticket,
      ...(nextTicket ? { nextTicket: true as const } : {}),
    });
    return client.next();
  };
  return { f, phone, exchanged, hello, handed };
}

test("a ticket handed over in a welcome opens the next socket once, and never again", async () => {
  const s = await setup();
  const first = s.handed(await s.hello(await s.exchanged()));
  expect(first.ttlMs).toBeGreaterThan(0);
  expect(first.ttlMs).toBeLessThanOrEqual(60_000);
  // The next connect skips the exchange: the handed ticket opens it, and hands over another.
  const second = await s.hello(first.ticket);
  expect(second).toMatchObject({ type: "welcome", hostId: "host" });
  expect(s.handed(second).ticket).not.toBe(first.ticket);
  // One use: the same ticket again is refused.
  expect(await s.hello(first.ticket)).toMatchObject({ type: "error", code: "unauthorized" });
});

test("revoking the device voids the ticket its last welcome handed over", async () => {
  const s = await setup();
  const next = s.handed(await s.hello(await s.exchanged()));
  const revoked = await fetch(`${s.f.server.httpUrl}/v1/devices/${s.phone.device.id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(await revoked.json()).toEqual({ revoked: true });
  expect(await s.hello(next.ticket)).toMatchObject({ type: "error", code: "unauthorized" });
});

test("a client that doesn't ask, or doesn't open with a ticket, gets no ticket", async () => {
  const s = await setup();
  const plain = await s.hello(await s.exchanged(), false);
  expect(plain.type).toBe("welcome");
  expect(plain.type === "welcome" && plain.ticket).toBeFalsy();
  const host = await s.f.connect();
  const welcome = await host.next();
  expect(welcome.type).toBe("welcome");
  expect(welcome.type === "welcome" && welcome.ticket).toBeFalsy();
});
