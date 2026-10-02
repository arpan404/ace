import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { keyPair, hostId } from "@ace/secure-channel";
import { connectClientViaRelay, startRelay } from "./index.ts";
import { peer, respond, deferred, address, openPeer } from "./testing/peer.ts";
import { ManualClock } from "./testing/clock.ts";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of cleanup.splice(0).toReversed()) await finish();
});
async function fakeHost() {
  const keys = keyPair();
  const received = deferred<Awaited<ReturnType<typeof respond>>>();
  const accepted = deferred<ReturnType<typeof peer>>();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  cleanup.push(() => {
    for (const socket of wss.clients) socket.terminate();
    return new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  wss.on("connection", (socket) => {
    const connection = peer(socket);
    accepted.resolve(connection);
    void connection
      .send(new Uint8Array([1]))
      .then(() => respond(connection, keys))
      .then(received.resolve)
      .catch(() => {});
  });
  const bound = wss.address();
  if (!bound || typeof bound === "string") throw new Error("No listener");
  const client = await connectClientViaRelay({
    relayUrl: `ws://127.0.0.1:${bound.port}`,
    hostId: hostId(keys.publicKey),
    pinnedFingerprint: hostId(keys.publicKey),
  });
  cleanup.push(() => client.close());
  return { client, connection: await accepted.promise, transport: await received.promise };
}
it("an authenticated peer cannot send a short non-final fragment", async () => {
  const { client, connection, transport } = await fakeHost();
  const receiving = expect(client.receive()).rejects.toThrow("Invalid encrypted fragment");
  const first = new TextEncoder().encode('{"type":');
  const last = new TextEncoder().encode('"pong"}');
  const fragment = (flag: number, data: Uint8Array) => {
    const plain = new Uint8Array(data.length + 1);
    plain[0] = flag;
    plain.set(data, 1);
    return transport.send.encrypt(plain);
  };
  await connection.send(fragment(0, first));
  await connection.send(fragment(1, last));
  await receiving;
  expect(await client.closed).toBeInstanceOf(Error);
});
it("authenticated ciphertext containing an invalid daemon message is rejected at the schema boundary", async () => {
  const { client, connection, transport } = await fakeHost();
  const receiving = expect(client.receive()).rejects.toThrow();
  const invalid = new TextEncoder().encode('{"type":"not-a-daemon-message"}');
  const plain = new Uint8Array(invalid.length + 1);
  plain[0] = 1;
  plain.set(invalid, 1);
  await connection.send(transport.send.encrypt(plain));
  await receiving;
  expect(await client.closed).toBeInstanceOf(Error);
});
it("an injected handshake deadline closes a silent peer without a real-time sleep", async () => {
  const clock = new ManualClock();
  const relay = await startRelay({ clock, limits: { handshakeTimeoutMs: 25 } });
  cleanup.push(() => relay.close());
  const silent = await openPeer(address(relay.url, "/host"));
  cleanup.push(() => silent.close());
  clock.advance(25);
  expect(await silent.closed).toBe(1006);
});
