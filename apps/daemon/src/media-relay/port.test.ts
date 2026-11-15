import { expect, it } from "vitest";
import { keyPair } from "@ace/secure-channel";
import type { ToMedia } from "@ace/media/wire";
import { lateMediaRelay, type MediaRelayPort } from "./port.ts";

const admit = async () => ({ ok: false as const });

function fakePort() {
  const sent: ToMedia[] = [];
  const watchers: Parameters<MediaRelayPort["watch"]>[0][] = [];
  const port: MediaRelayPort = {
    send: (message) => (sent.push(message), true),
    closeStream: () => {},
    need: () => () => {},
    available: () => true,
    claim: () => undefined,
    watch: (hooks) => void watchers.push(hooks),
  };
  return { port, sent, watchers };
}

it("media tickets are turned down until ace-media's runtime exists, then dialed through it", async () => {
  let live: MediaRelayPort | undefined;
  const relay = lateMediaRelay(() => live, { hostKeys: keyPair() });
  expect(relay.streams.offer("ws://relay/join?ticket=t", admit)).toBe(false);
  expect(relay.claim("A".repeat(43), { device: "phone", admission: "pairing" })).toBeUndefined();
  const fake = fakePort();
  live = fake.port;
  expect(relay.streams.offer("ws://relay/join?ticket=t", admit)).toBe(true);
  expect(fake.sent[0]).toMatchObject({ type: "relay.dial", url: "ws://relay/join?ticket=t" });
  // ace-media's word reaches the streams: a failed dial ends the pending stream.
  expect(fake.watchers).toHaveLength(1);
  const dial = fake.sent[0];
  if (dial?.type !== "relay.dial") throw new Error("no dial");
  fake.watchers[0]?.message(
    { type: "relay.failed", stream: dial.stream, reason: "dial" },
    new Uint8Array(0),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(relay.streams.pending).toBe(0);
});
