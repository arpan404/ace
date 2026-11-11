import { z } from "zod";

/**
 * Spade, ace's assistant, reached through the daemon (ADR 0117). The daemon forwards requests to
 * Spade's own HTTP API and passes bodies through as text: Spade owns their schemas.
 */

/** Largest request body a client sends: inbound frames are capped at 1 MiB with the envelope. */
export const maxSpadeRequestBytes = 512 * 1024;
/** Largest response body or live frame `data` the daemon forwards. */
export const maxSpadeResponseBytes = 1024 * 1024;

export const SpadeState = z.enum(["off", "starting", "ready", "failed"]);
export type SpadeState = z.infer<typeof SpadeState>;
export const SpadeStatus = z.object({
  state: SpadeState,
  /** Spade's own version, from `server.json`, once it has been ready. */
  version: z.string().max(64).optional(),
  /** Why Spade is off or failed, in words a person can read. */
  reason: z.string().max(1024).optional(),
});
export type SpadeStatus = z.infer<typeof SpadeStatus>;

const requestId = z.string().min(1).max(128);
/** A Spade API path: `/v1/...` with an optional query. The daemon checks it before forwarding. */
const path = z.string().min(4).max(2048);

/** Asks for Spade's status; afterwards this socket receives `spade.status.changed`. */
export const SpadeStatusRequest = z.object({ type: z.literal("spade.status"), requestId });
export const SpadeStatusResult = z.object({
  type: z.literal("spade.status.result"),
  requestId: z.string(),
  status: SpadeStatus,
});
export const SpadeStatusChanged = z.object({
  type: z.literal("spade.status.changed"),
  status: SpadeStatus,
});

export const SpadeMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type SpadeMethod = z.infer<typeof SpadeMethod>;
/** `GET` needs the read scope; every other method needs operate. */
export const SpadeHttpRequest = z.object({
  type: z.literal("spade.http"),
  requestId,
  method: SpadeMethod,
  path,
  /** Sent as is with `content-type: application/json`. */
  body: z.string().max(maxSpadeRequestBytes).optional(),
});
export type SpadeHttpRequest = z.infer<typeof SpadeHttpRequest>;

export const SpadeErrorCode = z.enum([
  "forbidden",
  /** The path is not a Spade API path (`/v1/...`). */
  "invalid_path",
  /** Spade is off, starting or failed. */
  "unavailable",
  /** Spade's answer was larger than the daemon forwards. */
  "too_large",
  /** The request reached Spade but no answer came back. */
  "failed",
  /** Too many live streams on this connection. */
  "limit",
]);
export type SpadeErrorCode = z.infer<typeof SpadeErrorCode>;
export const SpadeHttpResult = z.object({
  type: z.literal("spade.http.result"),
  requestId: z.string(),
  result: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("response"),
      status: z.number().int().min(100).max(599),
      body: z.string().max(maxSpadeResponseBytes),
    }),
    z.object({ kind: z.literal("error"), code: SpadeErrorCode, message: z.string().max(1024) }),
  ]),
});
export type SpadeHttpResult = z.infer<typeof SpadeHttpResult>;

/** Opens one of Spade's server-sent event streams, such as `/v1/conversations/{id}/live?after=N`. */
export const SpadeLiveSubscribe = z.object({
  type: z.literal("spade.live.subscribe"),
  requestId,
  path,
});
export const SpadeLiveUnsubscribe = z.object({
  type: z.literal("spade.live.unsubscribe"),
  requestId,
});
/** One server-sent event: its `event:` name and its `data:` text, unparsed. */
export const SpadeLiveFrame = z.object({
  type: z.literal("spade.live.frame"),
  requestId: z.string(),
  event: z.string().max(128),
  data: z.string().max(maxSpadeResponseBytes),
});
export type SpadeLiveFrame = z.infer<typeof SpadeLiveFrame>;
export const SpadeLiveEndReason = z.enum([
  /** Spade closed the stream. */
  "closed",
  /** Spade restarted or stopped; resubscribe with the last `seq` once it is ready. */
  "restarted",
  "unsubscribed",
  /** Spade refused to open the stream; `status` says how. */
  "refused",
  ...SpadeErrorCode.exclude(["failed"]).options,
]);
export type SpadeLiveEndReason = z.infer<typeof SpadeLiveEndReason>;
/** The stream is over; no more frames follow for this `requestId`. */
export const SpadeLiveEnded = z.object({
  type: z.literal("spade.live.ended"),
  requestId: z.string(),
  reason: SpadeLiveEndReason,
  /** Spade's HTTP status when it refused the stream. */
  status: z.number().int().min(100).max(599).optional(),
});
export type SpadeLiveEnded = z.infer<typeof SpadeLiveEnded>;

export const SpadeClientMessage = z.discriminatedUnion("type", [
  SpadeStatusRequest,
  SpadeHttpRequest,
  SpadeLiveSubscribe,
  SpadeLiveUnsubscribe,
]);
export type SpadeClientMessage = z.infer<typeof SpadeClientMessage>;
export const SpadeServerMessage = z.discriminatedUnion("type", [
  SpadeStatusResult,
  SpadeStatusChanged,
  SpadeHttpResult,
  SpadeLiveFrame,
  SpadeLiveEnded,
]);
export type SpadeServerMessage = z.infer<typeof SpadeServerMessage>;
