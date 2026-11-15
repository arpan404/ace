import { native } from "./test-host.ts";
import { ClientError } from "@ace/client";
import { mediaHello } from "@ace/client/media";
import { expect, test } from "vitest";
import { phoneMedia, type PhoneMediaOwner } from "./phone-media.ts";
import { nativeMediaRelay } from "./phone-media-relay.ts";
import { socketEvent } from "./socket.ts";

/*
 * The phone's media connection end to end at the native boundary: the main session's
 * `media.connect`, Swift's socket opened at the address with the ticket's hello as bytes, the
 * welcome that binds it, acks on it, and a new one for each new main session.
 */

const ticket = "A".repeat(43);
const granted = (connection: string) => ({
  type: "media.connect.result",
  requestId: "r",
  result: { ok: true, connection, url: "wss://studio.local:4612/media", ticket, expiresAt: 1 },
});

/** A main session whose socket generation the test moves; `answer` is its `media.connect` reply. */
function session(answer: () => Promise<unknown>) {
  let generation: number | undefined = 1;
  const listeners = new Set<() => void>();
  const owner = {
    request: () => answer(),
    connectionGeneration: () => ({
      getSnapshot: () => generation,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    }),
  } as unknown as PhoneMediaOwner;
  return {
    owner,
    move(next: number | undefined) {
      generation = next;
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

function nativeSockets() {
  const asked: { id: string; action: string; value: string }[] = [];
  native.socket = (id, action, value) => asked.push({ id, action, value });
  return asked;
}

const later = () => new Promise((resolve) => setTimeout(resolve, 0));
const never = () => () => {};

test("a granted media connection opens natively, says its hello in bytes and binds on welcome", async () => {
  const asked = nativeSockets();
  const main = session(async () => granted("mc_aaaaaaaa"));
  const media = phoneMedia(main.owner, {
    schedule: never,
    now: () => 0,
    codecs: () => ["avc1.42E033"],
  });
  await later();

  const open = asked.find((entry) => entry.action === "open");
  expect(JSON.parse(open?.value ?? "")).toEqual({
    media: { url: "wss://studio.local:4612/media" },
  });
  const id = open?.id ?? "";
  socketEvent(id, "open", "");
  const hello = asked.find((entry) => entry.action === "bytes");
  expect(Uint8Array.from(Buffer.from(hello?.value ?? "", "base64"))).toEqual(mediaHello(ticket));
  expect(media.route.binding()).toBeUndefined();

  socketEvent(id, "message", JSON.stringify({ type: "media.welcome", connection: "mc_aaaaaaaa" }));
  expect(media.route.binding()).toEqual({ connection: "mc_aaaaaaaa" });
  const ack = { type: "devices.ack", deviceId: "ios:x", streamId: "s", sequence: 4 } as const;
  expect(media.route.ack(ack)).toBe(true);
  expect(asked.at(-1)).toMatchObject({ id, action: "send" });
  expect(JSON.parse(asked.at(-1)?.value ?? "")).toEqual(ack);
  media.stop();
});

test("a new main session closes the old media connection and asks for a new one", async () => {
  const asked = nativeSockets();
  let next = 0;
  const connections = ["mc_aaaaaaaa", "mc_bbbbbbbb"];
  const main = session(async () => granted(connections[next++] ?? "mc_cccccccc"));
  const media = phoneMedia(main.owner, { schedule: never, now: () => 0, codecs: () => [] });
  await later();
  const first = asked.find((entry) => entry.action === "open")?.id ?? "";
  socketEvent(first, "open", "");
  socketEvent(
    first,
    "message",
    JSON.stringify({ type: "media.welcome", connection: "mc_aaaaaaaa" }),
  );

  main.move(2);
  await later();
  expect(asked).toContainEqual(expect.objectContaining({ id: first, action: "close" }));
  const second = asked.filter((entry) => entry.action === "open").at(-1)?.id ?? "";
  expect(second).not.toBe(first);
  socketEvent(second, "open", "");
  socketEvent(
    second,
    "message",
    JSON.stringify({ type: "media.welcome", connection: "mc_bbbbbbbb" }),
  );
  expect(media.route.binding()).toEqual({ connection: "mc_bbbbbbbb" });

  // The main session ended: no binding, and no socket left open.
  main.move(undefined);
  expect(media.route.binding()).toBeUndefined();
  expect(asked).toContainEqual(expect.objectContaining({ id: second, action: "close" }));
  media.stop();
});

test("a daemon that refuses media.connect keeps every picture on the main socket", async () => {
  const asked = nativeSockets();
  const main = session(async () => {
    throw new ClientError("protocol", "Unknown message type");
  });
  const media = phoneMedia(main.owner, { schedule: never, now: () => 0, codecs: () => [] });
  await later();
  expect(asked.filter((entry) => entry.action === "open")).toEqual([]);
  expect(media.connection.state).toMatchObject({ state: "legacy" });
  expect(media.route.binding()).toBeUndefined();
  media.stop();
});

/** A machine reached only through the relay: its grant names no address. */
const relayed = (connection: string) => ({
  type: "media.connect.result",
  requestId: "r",
  result: { ok: true, connection, ticket, expiresAt: 1 },
});
const throughRelay = (main: ReturnType<typeof session>) =>
  phoneMedia(main.owner, {
    relay: nativeMediaRelay({
      deviceId: "ios-device",
      credential: async () => ({ grant: "g.r.a.n.t" }),
    }),
    schedule: never,
    now: () => 0,
    codecs: () => [],
  });

test("through the relay the phone opens a media stream, says the ticket in its hello and binds on the welcome", async () => {
  const asked = nativeSockets();
  const media = throughRelay(session(async () => relayed("mc_aaaaaaaa")));
  await later();
  const open = asked.find((entry) => entry.action === "open");
  expect(JSON.parse(open?.value ?? "")).toEqual({ media: {} });
  const id = open?.id ?? "";
  socketEvent(id, "open", "");
  await later();
  const hello = JSON.parse(asked.find((entry) => entry.action === "send")?.value ?? "");
  expect(hello).toMatchObject({
    type: "hello",
    deviceId: "ios-device",
    grant: "g.r.a.n.t",
    channel: "media",
    mediaTicket: ticket,
  });
  // No binary hello on a relay stream: the JSON hello is the stream's own.
  expect(asked.some((entry) => entry.action === "bytes")).toBe(false);
  expect(media.route.binding()).toBeUndefined();

  socketEvent(id, "message", JSON.stringify({ type: "welcome", hostId: "H" }));
  expect(media.route.binding()).toEqual({ connection: "mc_aaaaaaaa" });
  const ack = { type: "screen.ack", sessionId: "s", streamId: "c", sequence: 2 } as const;
  expect(media.route.ack(ack)).toBe(true);
  expect(JSON.parse(asked.at(-1)?.value ?? "")).toEqual(ack);
  media.stop();
});

test("a relay stream the daemon refuses leaves every picture on the main socket", async () => {
  const asked = nativeSockets();
  const media = throughRelay(session(async () => relayed("mc_aaaaaaaa")));
  await later();
  const id = asked.find((entry) => entry.action === "open")?.id ?? "";
  socketEvent(id, "open", "");
  await later();
  socketEvent(id, "message", JSON.stringify({ type: "error", code: "media-ticket" }));
  expect(media.route.binding()).toBeUndefined();
  expect(media.connection.state).toMatchObject({ state: "legacy", reason: "relay-refused" });
  expect(asked).toContainEqual(expect.objectContaining({ id, action: "close" }));
  media.stop();
});
