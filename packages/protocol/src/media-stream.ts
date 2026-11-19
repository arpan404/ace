import { z } from "zod";
import { DeviceAck } from "./devices.ts";
import { ThreadId } from "./ids.ts";
import { MediaConnectionId } from "./media-connection.ts";
import { ScreenAck } from "./screen.ts";

/*
 * What crosses a media connection (ADR 0147 §4, docs/media/plan.md "Clients"), direct or relayed.
 *
 * - **Hello.** The client's first message is binary, 37 bytes: `"ACEC"`, a u8 version (1), then
 *   the 32-byte ticket from `media.connect` (base64url-decoded). ace-media accepts a ticket once,
 *   before it expires, and only while no revocation covers its owner; it answers
 *   `media.welcome`. Anything else closes the connection (`mediaCloseCodes.refused`). A
 *   connection has 2 s to send its hello. On a relay stream the hello is the relay channel's
 *   own (`channel: "media"`, `mediaTicket`), so no binary hello follows it.
 * - **Server to client.** Binary messages are `ACES` stream pieces (`@ace/browser/stream`), the
 *   same kinds and headers the main socket carries: `browserVideo`, `browserAudio`,
 *   `deviceFrame`, `screenFrame`. Text messages are `MediaStreamServerMessage`.
 * - **Client to server.** Text messages are `MediaStreamClientMessage`: acks and pings. Anything
 *   else (a subscribe, an RPC, an HTTP request, binary after the hello) closes the connection
 *   (`mediaCloseCodes.protocol`).
 */

/** The hello's first four bytes, `"ACEC"`. */
export const mediaHelloMagic = 0x41434543;
export const mediaHelloVersion = 1;
/** The hello's length: magic, version, ticket. */
export const mediaHelloBytes = 37;

/** WebSocket close codes a media connection ends with. */
export const mediaCloseCodes = {
  /** ace-media is stopping (idle, restart, shutdown): reopen with a new `media.connect`. */
  goingAway: 1001,
  /** The client sent something a media connection doesn't take. */
  protocol: 4400,
  /** The hello wasn't a valid, unused, unexpired ticket. */
  refused: 4401,
  /** The device's credential or admission was revoked. */
  revoked: 4403,
  /** No hello within 2 s. */
  helloTimeout: 4408,
  /** The main session that owned it closed, or the daemon closed it. */
  closed: 4410,
} as const;

/** `browser.ack` as a media connection takes it: the main socket's ack, without `requestId`. */
export const MediaBrowserAck = z.object({
  type: z.literal("browser.ack"),
  threadId: ThreadId,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** `sequence` is a video chunk's (acked cumulatively), not a JPEG frame's. */
  video: z.literal(true).optional(),
  /** The viewer's decoder lost its place (a decode error): send it a keyframe. */
  keyframe: z.literal(true).optional(),
});
export type MediaBrowserAck = z.infer<typeof MediaBrowserAck>;

/** The client's ping, with the round trip it measured on this connection, when it has one. */
export const MediaPing = z.object({
  type: z.literal("ping"),
  rttMs: z.number().int().nonnegative().max(60_000).optional(),
});

export const MediaStreamClientMessage = z.discriminatedUnion("type", [
  MediaBrowserAck,
  ScreenAck,
  DeviceAck,
  MediaPing,
]);
export type MediaStreamClientMessage = z.infer<typeof MediaStreamClientMessage>;

export const MediaStreamServerMessage = z.discriminatedUnion("type", [
  /** The hello was accepted: this is the connection to name in subscribes. */
  z.object({ type: z.literal("media.welcome"), connection: MediaConnectionId }),
  z.object({ type: z.literal("pong") }),
]);
export type MediaStreamServerMessage = z.infer<typeof MediaStreamServerMessage>;
