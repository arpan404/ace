import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { DeviceId } from "@ace/protocol";
import { connectHostToRelay, startRelay } from "@ace/relay";
import type { HostChannel } from "@ace/relay";
import { keyPair } from "@ace/secure-channel";
import { connectPortableRelay, type PortableSocket } from "./portable-relay.ts";

// The relay client sending its first handshake message as soon as its socket opens (ADR 0155,
// step 1), against the real self-hosted relay and the daemon's own host channel: only once the
// relay has said it may, and never otherwise.

const disposals: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).toReversed()) await dispose();
});

async function relayAndHost() {
  const relay = await startRelay();
  disposals.push(() => relay.close());
  let arrived = Promise.withResolvers<HostChannel>();
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys: keyPair(),
    onClientChannel: (channel) => arrived.resolve(channel),
  });
  disposals.push(() => host.close());
  /** One connection, with every frame the client sends and receives in order. */
  const connect = async (early: boolean) => {
    arrived = Promise.withResolvers<HostChannel>();
    const order: string[] = [];
    const socket = (url: string, protocols?: string[]): PortableSocket => {
      const real = new WebSocket(url, protocols);
      real.on("message", () => order.push("received"));
      const send = real.send.bind(real);
      return Object.assign(real, {
        send(data: string | Uint8Array) {
          order.push("sent");
          send(data);
        },
      }) as unknown as PortableSocket;
    };
    const client = await connectPortableRelay({
      relayUrl: relay.url,
      pinnedFingerprint: host.hostId,
      socket,
      keys: () => ({ staticKey: keyPair(), ephemeralKey: keyPair() }),
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      early,
    });
    disposals.push(() => client.close());
    const server = await arrived.promise;
    await client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse("phone"),
      token: "device token",
    });
    expect(await server.receive()).toMatchObject({ type: "hello" });
    return { client, order };
  };
  return { connect };
}

it("a client the relay lets send early sends its first handshake message before the marker", async () => {
  const h = await relayAndHost();
  const { client, order } = await h.connect(true);
  // First message out, then the marker and the daemon's answer.
  expect(order.slice(0, 3)).toEqual(["sent", "received", "received"]);
  expect(client.earlyCapable).toBe(true);
});

it("a client that may not send early waits for the marker, and learns the relay holds early frames", async () => {
  const h = await relayAndHost();
  const { client, order } = await h.connect(false);
  expect(order.slice(0, 2)).toEqual(["received", "sent"]);
  // Next time it may offer to send early.
  expect(client.earlyCapable).toBe(true);
});
