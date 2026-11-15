// Scratch (C1 + D2): the web client's media connection through the real self-hosted relay, the
// daemon's real hand-over responder admitting or refusing its hello.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { connectHostToRelay, startRelay } from "@ace/relay";
import { fingerprint, keyPair } from "@ace/secure-channel";
import { ServerMessage, type ClientMessage } from "@ace/protocol";
import { MediaConnection, relayMediaStreams } from "../../../../packages/client/src/media.ts";
import {
  browserDeviceSocket,
  ephemeralRelayKeys,
} from "../../../../packages/client/src/devices.ts";
import { handOverMediaStream, type StreamPipe } from "./handover.ts";
import { until } from "./testing-relay.ts";

type Hello = Extract<ClientMessage, { type: "hello" }>;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

/** One `/join` socket as the frames D2's responder reads and writes. */
function joinPipe(url: string): Promise<StreamPipe & { close(): void }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "nodebuffer";
    const inbox: Uint8Array[] = [];
    let waiting: ((frame: Uint8Array) => void) | undefined;
    socket.on("message", (data: Buffer) => {
      const frame = new Uint8Array(data);
      if (waiting) {
        const take = waiting;
        waiting = undefined;
        take(frame);
      } else inbox.push(frame);
    });
    socket.on("error", reject);
    socket.on("open", () =>
      resolve({
        send: async (frame) => void socket.send(frame),
        next: () =>
          new Promise((take) => {
            const frame = inbox.shift();
            if (frame) take(frame);
            else waiting = take;
          }),
        close: () => socket.close(),
      }),
    );
  });
}

async function setUp(options: { media: boolean; accept: (hello: Hello) => boolean }) {
  const relay = await startRelay({ bind: "127.0.0.1" });
  stops.push(() => relay.close());
  const hostKeys = keyPair();
  const hostId = fingerprint(hostKeys.publicKey);
  const hellos: Hello[] = [];
  const host = await connectHostToRelay({
    relayUrl: relay.url,
    hostKeys,
    onClientChannel: async (channel) => channel.close(),
    ...(options.media
      ? {
          media: {
            offer: (_ticket: string, joinUrl: string) => {
              void (async () => {
                const pipe = await joinPipe(joinUrl);
                stops.push(async () => pipe.close());
                await handOverMediaStream(pipe, {
                  hostKeys,
                  ephemeralKey: keyPair(),
                  admit: async (hello) => {
                    hellos.push(hello);
                    return options.accept(hello)
                      ? {
                          ok: true,
                          welcome: ServerMessage.parse({
                            type: "welcome",
                            hostId,
                            protocolVersion: 1,
                            headSeq: 0,
                          }),
                          grant: hello.mediaTicket,
                        }
                      : {
                          ok: false,
                          refusal: ServerMessage.parse({
                            type: "error",
                            code: "unauthorized",
                            message: "Valid hello required",
                          }),
                        };
                  },
                });
              })().catch(() => {});
              return true;
            },
          },
        }
      : {}),
  });
  stops.push(() => host.close());
  return { relay, hostId, hellos };
}

const ticket = Buffer.alloc(32, 7).toString("base64url");

function client(relayUrl: string, hostId: string) {
  const media = new MediaConnection({
    connect: async () => ({
      type: "media.connect.result",
      requestId: "r",
      result: { ok: true, connection: "mc_relayrelay", ticket, expiresAt: Date.now() + 30_000 },
    }),
    socket: () => {
      throw new Error("no url: the relay carries it");
    },
    relay: () =>
      relayMediaStreams({
        relayUrl,
        pinnedFingerprint: hostId,
        deviceId: "device-relay-1",
        credential: async () => "paired-token",
        socket: browserDeviceSocket,
        keys: ephemeralRelayKeys,
        schedule: (run, ms) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
      }),
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    now: () => performance.now(),
  });
  stops.push(async () => media.stop());
  return media;
}

describe("the web media connection through D2's relay", () => {
  it("opens through a relay stream with the media purpose, its hello presenting the ticket", async () => {
    const { relay, hostId, hellos } = await setUp({ media: true, accept: () => true });
    const media = client(relay.url, hostId);
    media.start();
    await until(() => media.binding() !== undefined);
    expect(media.binding()).toEqual({ connection: "mc_relayrelay" });
    expect(hellos).toEqual([
      expect.objectContaining({
        channel: "media",
        mediaTicket: ticket,
        deviceId: "device-relay-1",
      }),
    ]);
  });

  it("falls back to legacy when the daemon refuses the ticket", async () => {
    const { relay, hostId, hellos } = await setUp({ media: true, accept: () => false });
    const media = client(relay.url, hostId);
    media.start();
    await until(() => media.state.state === "legacy");
    expect(media.state).toEqual({ state: "legacy", reason: "relay-refused" });
    expect(hellos).toHaveLength(1);
  });

  it("falls back to legacy when the daemon takes no media streams", async () => {
    const { relay, hostId } = await setUp({ media: false, accept: () => true });
    const media = client(relay.url, hostId);
    media.start();
    await until(() => media.state.state === "legacy");
    expect(media.state).toEqual({ state: "legacy", reason: "relay-refused" });
  });
});
