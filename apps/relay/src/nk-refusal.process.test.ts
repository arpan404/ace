import { afterEach, expect, it } from "vitest";
import { NoiseNK, keyPair } from "@ace/secure-channel";
import { connectHostToRelay, startRelay, type NkHost } from "./index.ts";
import { address, openPeer } from "./testing/peer.ts";
import { NK_REFUSAL_MS, NK_STREAM_PROLOGUE, PAIRED_MARKER } from "./wire.ts";

// A refused NK first message (ADR 0155, step 2) over real sockets: the client's stream closes
// with nothing sent. The fixed deadline for every kind of refusal is tested on the relay's own
// clock in nk-refusal.test.ts.

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function refusedAfter(nk: NkHost | undefined): Promise<number> {
  const relay = await startRelay();
  cleanups.push(() => relay.close());
  const keys = keyPair();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keys,
    ...(nk ? { nk } : {}),
    onClientChannel: (channel) => channel.close(),
  });
  cleanups.push(() => host.close());
  const client = await openPeer(address(relay.url, "/client", { hostId: host.hostId }));
  cleanups.push(() => client.close());
  expect([...(await client.next())]).toEqual([PAIRED_MARKER]);
  const first = NoiseNK.initiator({
    remoteStatic: keys.publicKey,
    ephemeralKey: keyPair(),
    prologue: NK_STREAM_PROLOGUE,
  }).writeMessage(new TextEncoder().encode("{}"));
  const sent = performance.now();
  await client.send(first);
  // Nothing is ever answered: the next thing is the close.
  await expect(client.next()).rejects.toThrow();
  return performance.now() - sent;
}

it("a refused NK first message closes the client with nothing sent, never before the refusal time", async () => {
  // When the deadline falls for each kind of refusal is held in nk-refusal.test.ts on the
  // relay's clock; this shows the real sockets: a close and no answer, no earlier than it.
  const took = await refusedAfter({ arrive: () => true, admit: async () => undefined });
  expect(took).toBeGreaterThanOrEqual(NK_REFUSAL_MS - 5);
});
