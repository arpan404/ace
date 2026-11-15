import { describe, expect, it } from "vitest";
import { ServerMessage, type ClientMessage } from "@ace/protocol";
import { relayMediaStreams } from "./media-relay.ts";
import type { PortableRelay, PortableRelayOptions } from "./portable-relay.ts";
import type { MediaRelayEvents } from "./media-connection.ts";

const hostId = "A".repeat(52);
const ticket = "T".repeat(43);
const welcome = (from: string) =>
  ServerMessage.parse({ type: "welcome", hostId: from, protocolVersion: 1, headSeq: 0 });

/** A relay stream the test answers: what the client sent, and what the daemon says back. */
function fakeRelay() {
  const sent: ClientMessage[] = [];
  const texts: string[] = [];
  const inbox: (ServerMessage | Uint8Array | string | Error)[] = [];
  let waiting: ((value: ServerMessage | Uint8Array | string | Error) => void) | undefined;
  let asked: PortableRelayOptions | undefined;
  let closed = false;
  const next = () =>
    new Promise<ServerMessage | Uint8Array | string | Error>((resolve) => {
      const queued = inbox.shift();
      if (queued !== undefined) resolve(queued);
      else waiting = resolve;
    });
  const take = async () => {
    const value = await next();
    if (value instanceof Error) throw value;
    return value;
  };
  const relay: PortableRelay = {
    send: async (message) => void sent.push(message),
    sendText: async (text) => void texts.push(text),
    receive: async () => {
      const value = await take();
      if (typeof value === "string") throw new Error("text where a message was expected");
      return value;
    },
    receiveRaw: async () => {
      const value = await take();
      if (typeof value === "string" || value instanceof Uint8Array) return value;
      return JSON.stringify(value);
    },
    close: () => void (closed = true),
  };
  return {
    connect: async (options: PortableRelayOptions) => {
      asked = options;
      return relay;
    },
    sent,
    texts,
    asked: () => asked,
    closed: () => closed,
    push(value: ServerMessage | Uint8Array | string | Error) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve(value);
      } else inbox.push(value);
    },
  };
}

function events() {
  const seen: string[] = [];
  const messages: (string | Uint8Array)[] = [];
  const handlers: MediaRelayEvents = {
    welcome: () => seen.push("welcome"),
    message: (data) => messages.push(data),
    close: (code) => seen.push(`close ${code}`),
  };
  return { seen, messages, handlers };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function open(relay: ReturnType<typeof fakeRelay>) {
  return relayMediaStreams({
    relayUrl: "ws://127.0.0.1:1",
    pinnedFingerprint: hostId,
    deviceId: "device-1",
    credential: async () => "paired-token",
    socket: () => {
      throw new Error("the fake relay opens no socket");
    },
    keys: () => {
      throw new Error("the fake relay needs no keys");
    },
    schedule: () => () => {},
    connect: relay.connect,
  });
}

describe("media connections through the relay", () => {
  it("asks for a media stream and presents the ticket in a media hello", async () => {
    const relay = fakeRelay();
    const { handlers } = events();
    open(relay)(ticket, handlers);
    await flush();
    expect(relay.asked()?.purpose).toBe("media");
    expect(relay.asked()?.pinnedFingerprint).toBe(hostId);
    expect(relay.sent).toEqual([
      expect.objectContaining({
        type: "hello",
        deviceId: "device-1",
        token: "paired-token",
        channel: "media",
        mediaTicket: ticket,
        flowControl: ["credit"],
      }),
    ]);
  });

  it("is open once the daemon welcomes it, then carries pieces and text both ways", async () => {
    const relay = fakeRelay();
    const { seen, messages, handlers } = events();
    const stream = open(relay)(ticket, handlers);
    await flush();
    relay.push(welcome(hostId));
    await flush();
    expect(seen).toEqual(["welcome"]);
    relay.push(Uint8Array.of(1, 2, 3));
    relay.push('{"type":"pong"}');
    await flush();
    expect(messages).toEqual([Uint8Array.of(1, 2, 3), '{"type":"pong"}']);
    stream.send('{"type":"ping"}');
    await flush();
    expect(relay.texts).toEqual(['{"type":"ping"}']);
  });

  it("closes as refused when the daemon answers the hello with an error", async () => {
    const relay = fakeRelay();
    const { seen, handlers } = events();
    open(relay)(ticket, handlers);
    await flush();
    relay.push({ type: "error", code: "unauthorized", message: "Valid hello required" });
    await flush();
    expect(seen).toEqual(["close 4401"]);
    expect(relay.closed()).toBe(true);
  });

  it("refuses a welcome from a host other than the pinned one", async () => {
    const relay = fakeRelay();
    const { seen, handlers } = events();
    open(relay)(ticket, handlers);
    await flush();
    relay.push(welcome("B".repeat(52)));
    await flush();
    expect(seen).toEqual(["close 4401"]);
  });
});
