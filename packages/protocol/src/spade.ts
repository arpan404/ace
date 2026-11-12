import { z } from "zod";
import { ThreadId } from "./ids.ts";

/**
 * Spade, ace's assistant, reached through the daemon (ADR 0121). The daemon forwards requests to
 * Spade's own HTTP API and passes bodies through as text: Spade owns their schemas.
 */

/** Largest request body a client sends: inbound frames are capped at 1 MiB with the envelope. */
export const maxSpadeRequestBytes = 512 * 1024;
/** Largest response body or live frame `data` the daemon forwards. */
export const maxSpadeResponseBytes = 1024 * 1024;
/** Largest answer from `GET /v1/images/...`: one stored image. */
export const maxSpadeImageBytes = 5 * 1024 * 1024;
/**
 * Largest request body for `POST /v1/conversations` and `POST /v1/conversations/{id}/messages`,
 * sent in parts: 8 documents of 32 MB and 8 images as base64 in JSON, and a recording, as Spade
 * takes it (`spade/docs/media.md`). Every other route keeps `maxSpadeRequestBytes`.
 */
export const maxSpadeUploadBytes = 400 * 1024 * 1024;
/** Largest request body for `POST /v1/transcriptions`: a 25 MB recording as base64 in JSON. */
export const maxSpadeTranscriptionBytes = 36 * 1024 * 1024;
/** Largest answer from `GET /v1/documents/{sha256}`: one stored document. */
export const maxSpadeDocumentBytes = 32 * 1024 * 1024;
/** Largest answer from `GET /v1/audio/{sha256}`: one stored recording. */
export const maxSpadeAudioBytes = 25 * 1024 * 1024;
/** Characters in one `spade.http.part`, so each fits every transport's message limit. */
export const maxSpadePartChars = 192 * 1024;
/** Most parts in one upload: room for `maxSpadeUploadBytes` at `maxSpadePartChars` each. */
export const maxSpadeParts = 4096;
/**
 * Characters of an answer's body in one message: a longer answer comes in pieces of this size,
 * the first in `spade.http.result` and the rest read with `spade.http.read`.
 */
export const maxSpadeChunkChars = 768 * 1024;
/** A body as text, or as base64 for bytes that aren't text (an image). */
export const SpadeBodyEncoding = z.enum(["text", "base64"]);
export type SpadeBodyEncoding = z.infer<typeof SpadeBodyEncoding>;

export const SpadeState = z.enum(["off", "starting", "ready", "failed"]);
export type SpadeState = z.infer<typeof SpadeState>;
export const SpadeStatus = z.object({
  state: SpadeState,
  /** Spade's own version, from `server.json`, once it has been ready. */
  version: z.string().max(64).optional(),
  /** Why Spade is off or failed, in words a person can read. */
  reason: z.string().max(1024).optional(),
  /**
   * Spade's host thread, once the daemon has made it: the parent of every thread Spade's tools
   * delegate. `busy` while any thread under it is still working or waiting on a person.
   */
  thread: z.object({ id: ThreadId, busy: z.boolean() }).optional(),
  /**
   * Spade's grant for ace's tools (ADR 0123), once one was made: `present` while it works,
   * `revoked` once Spade was turned off or the person revoked it. Never carries a token. Shown
   * and revoked here, never among outside clients' grants.
   */
  grant: z
    .object({
      state: z.enum(["present", "revoked"]),
      /** When Spade last called ace with it; null when it hasn't since it was handed over. */
      lastUsedAt: z.number().int().nonnegative().nullable(),
    })
    .optional(),
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

/**
 * Revokes Spade's grant: ace's tools stop working for Spade at once, and stay off until Spade is
 * turned on again. Admin devices only.
 */
export const SpadeGrantRevoke = z.object({ type: z.literal("spade.grant.revoke"), requestId });
export const SpadeGrantRevokeResult = z.object({
  type: z.literal("spade.grant.revoke.result"),
  requestId: z.string(),
  /** False: there was no live grant, or this device may not revoke it. */
  revoked: z.boolean(),
});

export const SpadeMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export type SpadeMethod = z.infer<typeof SpadeMethod>;
/**
 * `GET` needs the read scope; every other method needs operate. A body comes inline in `body`,
 * or, when `parts` is set, in that many `spade.http.part` messages, which the daemon streams to
 * Spade as they arrive, once `spade.http.open` says the request is open.
 */
export const SpadeHttpRequest = z.object({
  type: z.literal("spade.http"),
  requestId,
  method: SpadeMethod,
  path,
  body: z.string().max(maxSpadeRequestBytes).optional(),
  /** How `body` and every part are written; text by default. */
  encoding: SpadeBodyEncoding.default("text"),
  /** Sent to Spade as `content-type`; `application/json` by default. */
  contentType: z.string().min(1).max(256).optional(),
  /** The body follows in this many parts instead of `body`. */
  parts: z.number().int().min(1).max(maxSpadeParts).optional(),
});
export type SpadeHttpRequest = z.infer<typeof SpadeHttpRequest>;

/**
 * One piece of a request body, `index` counting from 0, in the request's encoding. Base64 parts
 * other than the last hold a multiple of 4 characters; text parts never split a surrogate pair.
 */
export const SpadeHttpPart = z.object({
  type: z.literal("spade.http.part"),
  requestId,
  index: z
    .number()
    .int()
    .min(0)
    .max(maxSpadeParts - 1),
  body: z.string().max(maxSpadePartChars),
});
export type SpadeHttpPart = z.infer<typeof SpadeHttpPart>;
/**
 * A request with `parts` is open: the daemon took it and holds a place for its parts. Send the
 * parts only after this; a refusal comes as `spade.http.result` instead, before any part.
 */
export const SpadeHttpOpen = z.object({
  type: z.literal("spade.http.open"),
  requestId: z.string(),
});

/**
 * Asks for one more piece of a long answer (`index` from 1). The daemon holds an answer's
 * pieces for 60 seconds, and lets them go once the last is read.
 */
export const SpadeHttpRead = z.object({
  type: z.literal("spade.http.read"),
  requestId,
  index: z.number().int().min(1).max(63),
});
export type SpadeHttpRead = z.infer<typeof SpadeHttpRead>;
/** One piece of a long answer. `gone`: the daemon no longer holds it; send the request again. */
export const SpadeHttpChunk = z.object({
  type: z.literal("spade.http.chunk"),
  requestId: z.string(),
  index: z.number().int().min(1).max(63),
  body: z.string().max(maxSpadeChunkChars),
  gone: z.literal(true).optional(),
});
export type SpadeHttpChunk = z.infer<typeof SpadeHttpChunk>;

export const SpadeErrorCode = z.enum([
  "forbidden",
  /** The path is not a Spade API path (`/v1/...`). */
  "invalid_path",
  /** Spade is off, starting or failed. */
  "unavailable",
  /** The request or Spade's answer was larger than the daemon forwards for that route. */
  "too_large",
  /** A body or part the daemon can't send: bad base64, a part out of order or missing. */
  "invalid_body",
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
      /**
       * Text for textual content types (JSON, `text/*`), else base64 of the bytes. When `parts`
       * is set this is the first piece; the whole body is every piece joined in order.
       */
      body: z.string().max(maxSpadeChunkChars),
      encoding: SpadeBodyEncoding.default("text"),
      /** Spade's `content-type`, when it sent one. */
      contentType: z.string().max(256).optional(),
      /** How many pieces the body has, when more than one: read pieces 1 to parts - 1. */
      parts: z.number().int().min(2).max(64).optional(),
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
  SpadeHttpPart,
  SpadeHttpRead,
  SpadeLiveSubscribe,
  SpadeLiveUnsubscribe,
  SpadeGrantRevoke,
]);
export type SpadeClientMessage = z.infer<typeof SpadeClientMessage>;
export const SpadeServerMessage = z.discriminatedUnion("type", [
  SpadeStatusResult,
  SpadeStatusChanged,
  SpadeHttpResult,
  SpadeHttpOpen,
  SpadeHttpChunk,
  SpadeLiveFrame,
  SpadeLiveEnded,
  SpadeGrantRevokeResult,
]);
export type SpadeServerMessage = z.infer<typeof SpadeServerMessage>;
