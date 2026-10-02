import { afterEach, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { NoiseXX, keyPair, hostId } from "@ace/secure-channel";
import { startRelay, connectClientViaRelay } from "./index.ts";
import { address, openPeer, peer, deferred, CONTROL, STREAM } from "./testing/peer.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

it.each([1, 3])(
  "registration rejects a nonempty handshake message %i without registering the host",
  async (phase) => {
    const relay = await startRelay();
    cleanups.push(() => relay.close());
    const connection = await openPeer(address(relay.url, "/host"));
    cleanups.push(() => connection.close());
    const noise = new NoiseXX({
      initiator: true,
      staticKey: keyPair(),
      ephemeralKey: keyPair(),
      prologue: CONTROL,
    });
    cleanups.push(() => noise.destroy());
    const payload = new TextEncoder().encode("unexpected payload");
    await connection.send(noise.writeMessage(phase === 1 ? payload : new Uint8Array()));
    if (phase === 3) {
      noise.readMessage(await connection.next());
      await connection.send(noise.writeMessage(payload));
    }
    // A registration confirmation would be an encrypted frame after message three.
    await expect(connection.next()).rejects.toThrow("closed");
    expect(await connection.closed).toBe(1006);
  },
);

it("a pinned stream responder with a nonempty second handshake payload is rejected", async () => {
  const keys = keyPair();
  const accepted = deferred<ReturnType<typeof peer>>();
  const sent = deferred<void>();
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  cleanups.push(() => {
    for (const socket of wss.clients) socket.terminate();
    return new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  wss.on("connection", (socket) => {
    const connection = peer(socket);
    accepted.resolve(connection);
    const noise = new NoiseXX({
      initiator: false,
      staticKey: keys,
      ephemeralKey: keyPair(),
      prologue: STREAM,
    });
    cleanups.push(() => noise.destroy());
    void (async () => {
      await connection.send(new Uint8Array([1]));
      noise.readMessage(await connection.next());
      await connection.send(noise.writeMessage(new TextEncoder().encode("unexpected payload")));
    })().then(sent.resolve, sent.reject);
  });
  const bound = wss.address();
  if (!bound || typeof bound === "string") throw new Error("No listener");
  const connecting = connectClientViaRelay({
    relayUrl: `ws://127.0.0.1:${bound.port}`,
    hostId: hostId(keys.publicKey),
    pinnedFingerprint: hostId(keys.publicKey),
  });
  // Cleanup still owns the channel if a regression incorrectly admits it.
  void connecting.then(
    (channel) => cleanups.push(() => channel.close()),
    () => {},
  );
  const rejected = expect(connecting).rejects.toThrow("Handshake payload must be empty");
  await sent.promise;
  await rejected;
  expect(await (await accepted.promise).closed).toBe(1006);
});
