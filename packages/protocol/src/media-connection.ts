import { z } from "zod";

/*
 * A client's media connection (ADR 0147 §4, docs/media/plan.md "Media connection
 * authorization" and "Clients"). Live video, device and screen pictures reach a client on a
 * connection of their own to ace-media, beside its main socket. The client asks its main session
 * for one with `media.connect`, opens it with the single-use ticket it got, and then names it in
 * its subscribes (`media: {connection}`). What crosses the media connection itself is in
 * `media-stream.ts`.
 */

/** A media connection, minted by the daemon: `mc_` and up to 61 base64url characters. */
export const MediaConnectionId = z.string().regex(/^mc_[A-Za-z0-9_-]{8,61}$/);
export type MediaConnectionId = z.infer<typeof MediaConnectionId>;

/** A single-use media ticket: 32 random bytes, base64url without padding. */
export const MediaTicket = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export type MediaTicket = z.infer<typeof MediaTicket>;

/** A WebCodecs codec string (`avc1.42E033`, `hvc1.1.6.L153.B0`, `vp8`, `vp09.00.10.08`). */
export const MediaCodec = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9.]+$/);
export type MediaCodec = z.infer<typeof MediaCodec>;

/** The decoders a viewer has, best first. */
export const MediaCodecs = z.array(MediaCodec).min(1).max(8);

/**
 * A subscribe's `media`: deliver this subscription on that media connection instead of the main
 * socket. The connection must belong to the main session the subscribe arrives on; one of
 * another session or another device is refused (`media-connection`).
 */
export const MediaBinding = z.object({ connection: MediaConnectionId });
export type MediaBinding = z.infer<typeof MediaBinding>;

/**
 * Asks for a media connection. Any session that may view asks; the connection belongs to it, its
 * device and that device's admission, and closes with any of them.
 */
export const MediaConnectRequest = z.object({
  type: z.literal("media.connect"),
  requestId: z.string().min(1).max(128),
});
export type MediaConnectRequest = z.infer<typeof MediaConnectRequest>;

/** Why a media connection wasn't made. The client's live views get no pictures and say why. */
export const MediaConnectFailure = z.object({
  ok: z.literal(false),
  /**
   * `unavailable` (ace-media isn't serving viewers: it isn't running or isn't healthy), `limit` (too many connections), `refused` (this session may not view). An open
   * string, so a later code still parses.
   */
  code: z.string().min(1).max(64),
  message: z.string().max(256),
});

export const MediaConnectGranted = z.object({
  ok: z.literal(true),
  connection: MediaConnectionId,
  /**
   * Where to open it: `ws://127.0.0.1:<port>/media` on loopback, `wss://<address>:<port>/media`
   * on the LAN and Tailscale listeners (the daemon's own certificate). Absent when only the
   * relay reaches this client (a relay stream with the `media` purpose, D2).
   */
  url: z.string().min(1).max(2048).optional(),
  /** Presented once, in the media connection's hello (`media-stream.ts`), before `expiresAt`. */
  ticket: MediaTicket,
  /** The daemon's wall clock, in Unix milliseconds: 30 s after it was issued. */
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type MediaConnectGranted = z.infer<typeof MediaConnectGranted>;

export const MediaConnectResult = z.object({
  type: z.literal("media.connect.result"),
  requestId: z.string().max(128),
  result: z.discriminatedUnion("ok", [MediaConnectGranted, MediaConnectFailure]),
});
export type MediaConnectResult = z.infer<typeof MediaConnectResult>;

/**
 * A viewport-sized still of the source, made by ace-media's still path at 10–20 KB (ADR 0149),
 * so a picture shows within about a second on 3G before video starts.
 */
export const MediaPoster = z.object({
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  /** The JPEG, base64. */
  jpeg: z
    .string()
    .min(1)
    .max(64 * 1024),
});
export type MediaPoster = z.infer<typeof MediaPoster>;

/**
 * On the reply to a subscribe that named a media connection (`browser.result`, `screen.result`,
 * `devices.result`): the connection the pictures will arrive on, and a poster when the source
 * already had a picture.
 */
export const MediaSubscribed = z.object({
  connection: MediaConnectionId,
  poster: MediaPoster.optional(),
});
export type MediaSubscribed = z.infer<typeof MediaSubscribed>;

/**
 * On the reply to a subscribe whose pictures won't come (X3: only ace-media delivers live
 * views, on the client's media connection), why, for the live view to say instead of showing a
 * blank pane. `update`: the subscribe named no media connection, so the client is older than
 * this daemon; `unavailable`: ace-media can't serve this view now (it is starting, it keeps
 * failing, or this computer can't stream the source). An open string, so a later code still
 * parses. The subscription itself stands: state and controls work as before.
 */
export const MediaUndelivered = z.object({
  code: z.string().min(1).max(64),
  reason: z.string().min(1).max(512),
});
export type MediaUndelivered = z.infer<typeof MediaUndelivered>;
