import { once } from "node:events";
import { describe, it, expect, afterEach } from "vitest";
import { fixture, token } from "./socket-test-support.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}
const hello = { type: "hello", protocolVersion: 1, deviceId: "device", token };
describe("authentication boundaries", () => {
  it.each([
    ["non-hello first frame", { type: "ping" }],
    ["token prefix followed by extra bytes", { ...hello, token: token + "suffix" }],
    ["unsupported protocol version", { ...hello, protocolVersion: 2 }],
    ["missing token", { type: "hello", protocolVersion: 1, deviceId: "device" }],
  ])("closes without sending data for a %s", async (_name, frame) => {
    const f = await setup();
    const client = await f.open();
    const closed = once(client.socket, "close");
    client.socket.send(JSON.stringify(frame));
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await closed)[0]).toBe(4001);
    await expect(client.next()).rejects.toThrow("Socket closed");
  });
  it("rejects a binary first frame even when it contains a valid hello", async () => {
    const f = await setup();
    const client = await f.open();
    const closed = once(client.socket, "close");
    client.socket.send(Buffer.from(JSON.stringify(hello)));
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await closed)[0]).toBe(4001);
  });
  it("closes on a second hello without sending another welcome or heartbeat", async () => {
    const f = await setup();
    const client = await f.connect();
    expect((await client.next()).type).toBe("welcome");
    const closed = once(client.socket, "close");
    client.socket.send(JSON.stringify(hello));
    client.send({ type: "ping" });
    expect(await client.next()).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await closed)[0]).toBe(4001);
    await expect(client.next()).rejects.toThrow("Socket closed");
  });
  it("rejects a negative replay cursor while keeping the authenticated socket usable", async () => {
    const f = await setup();
    const client = await f.connect();
    await client.next();
    client.socket.send(
      JSON.stringify({
        type: "subscribe",
        subscriptionId: "s",
        scope: { kind: "threads" },
        afterSeq: -1,
      }),
    );
    expect(await client.next()).toMatchObject({ type: "error", code: "invalid_message" });
    client.send({ type: "ping" });
    expect(await client.next()).toEqual({ type: "pong" });
  });
});
