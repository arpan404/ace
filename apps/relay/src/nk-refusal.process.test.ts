import { afterEach, expect, it } from "vitest";
import { NoiseNK, keyPair } from "@ace/secure-channel";
import { connectHostToRelay, startRelay, type NkHost } from "./index.ts";
import { address, openPeer } from "./testing/peer.ts";
import { NK_REFUSAL_MS, NK_STREAM_PROLOGUE, PAIRED_MARKER } from "./wire.ts";

// Refusals of an NK first message (ADR 0155, step 2) look the same whatever the reason: the
// stream closes with nothing sent, one fixed time after the message arrived, whether the
// daemon's check is slow, refused at once, over its rate, or the daemon doesn't take NK.

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

const never = new Promise<undefined>(() => {});
const cases: [string, NkHost | undefined][] = [
  ["a check that would wait on the network", { arrive: () => true, admit: () => never }],
  ["an immediate refusal", { arrive: () => true, admit: async () => undefined }],
  ["a daemon over its rate", { arrive: () => false, admit: async () => undefined }],
  ["a daemon that doesn't take NK", undefined],
];

it.each(cases)("%s is refused at the same fixed time after arrival", async (_name, nk) => {
  const took = await refusedAfter(nk);
  expect(took).toBeGreaterThanOrEqual(NK_REFUSAL_MS - 5);
  expect(took).toBeLessThan(NK_REFUSAL_MS + 150);
});
