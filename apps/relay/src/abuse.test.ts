import { afterEach, expect, it } from "vitest";
import { startRelay } from "./index.ts";
import { openPeer as dial, address as relayAddress, deferred } from "./testing/peer.ts";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
it("excessive WebSocket fragmentation is rejected even below the byte limit", async () => {
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  const { socket } = await dial(relayAddress(relay.url, "/host"));
  cleanups.push(() => socket.terminate());
  const ended = new Promise<number>((resolve) => socket.once("close", resolve));
  for (let i = 0; i < 257; i++) socket.send(new Uint8Array([0]), { fin: false, binary: true });
  socket.send(new Uint8Array([0]), { fin: true, binary: true });
  expect(await ended).toBe(1008);
});
it("host shutdown closes live encrypted channels and a blocked receive", async () => {
  const { connectHostToRelay, connectClientViaRelay } = await import("./index.ts");
  const { keyPair } = await import("@ace/secure-channel");
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  const arrived = deferred<void>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel() {
      arrived.resolve();
    },
  });
  cleanups.push(() => host.close());
  const client = await connectClientViaRelay({
    relayUrl: relay.url,
    hostId: host.hostId,
    pinnedFingerprint: host.hostId,
  });
  cleanups.push(() => client.close());
  await arrived.promise;
  const blocked = client.receive();
  const rejected = expect(blocked).rejects.toThrow("closed");
  await host.close();
  await rejected;
  expect(await client.closed).toBeInstanceOf(Error);
});
