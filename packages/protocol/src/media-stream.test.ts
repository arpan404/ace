import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { z } from "zod";
import { BrowserClientMessage } from "./browser.ts";
import { CoreClientMessage } from "./wire-core.ts";
import { DeviceClientMessage } from "./devices.ts";
import { MediaStreamClientMessage, MediaStreamServerMessage } from "./media-stream.ts";
import { ScreenClientMessage } from "./screen.ts";

const vectors = new URL("../../../native/media/vectors/media-link/messages.json", import.meta.url);
const Vector = z.object({
  direction: z.enum(["client", "server"]),
  valid: z.boolean(),
  message: z.unknown(),
  parsed: z.unknown().optional(),
});

test("a media connection takes the acks and pings ace-media takes, and nothing else", () => {
  const all = z.array(Vector).parse(JSON.parse(readFileSync(vectors, "utf8")));
  for (const vector of all) {
    const schema =
      vector.direction === "client" ? MediaStreamClientMessage : MediaStreamServerMessage;
    const parsed = schema.safeParse(vector.message);
    expect(parsed.success, JSON.stringify(vector.message)).toBe(vector.valid);
    if (parsed.success) expect(parsed.data).toEqual(vector.parsed ?? vector.message);
  }
});

const connection = "mc_0123456789ab";

const browser = (media: unknown) =>
  BrowserClientMessage.safeParse({
    type: "browser.subscribe",
    requestId: "r",
    threadId: "thread-1",
    media,
  }).success;
const screen = (media: unknown, codecs?: unknown) =>
  ScreenClientMessage.safeParse({
    type: "screen.request",
    requestId: "r",
    operation: { op: "subscribe", sessionId: "s-1", media, codecs },
  }).success;
const device = (media: unknown, codecs?: unknown) =>
  DeviceClientMessage.safeParse({
    type: "devices.request",
    requestId: "r",
    operation: { op: "subscribe", deviceId: "android:emulator-5554", media, codecs },
  }).success;
const hello = (extra: object) =>
  CoreClientMessage.safeParse({
    type: "hello",
    protocolVersion: 1,
    deviceId: "device-1",
    token: "secret",
    ...extra,
  }).success;

test("subscribes name a media connection, and a malformed one is refused", () => {
  for (const accepts of [browser, screen, device]) {
    expect(accepts({ connection })).toBe(true);
    expect(accepts({ connection: "c-1" })).toBe(false);
    expect(accepts({ connection: `mc_${"a".repeat(62)}` })).toBe(false);
  }
  expect(screen({ connection }, ["hvc1.1.6.L153.B0", "avc1.42E033"])).toBe(true);
  expect(device({ connection }, [])).toBe(false);
  expect(device({ connection }, ["avc1 42"])).toBe(false);
});

test("a relay media hello carries a media ticket beside the device's credential", () => {
  expect(hello({ channel: "media", mediaTicket: "A".repeat(43) })).toBe(true);
  expect(hello({ channel: "media", mediaTicket: "A".repeat(42) })).toBe(false);
  expect(hello({ channel: "media", mediaTicket: "A+".repeat(21) + "A" })).toBe(false);
});
