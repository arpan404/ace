import { z } from "zod";
import { maxSpadeResponseBytes, maxSpadeUploadBytes, SpadeMethod } from "@ace/protocol";

/*
 * The desktop app's direct path to Spade (ADR 0123): the page asks the main process, which
 * holds Spade's address and token and makes the request on loopback. The token never reaches
 * the page.
 */

const Version = z.string().max(64);
const Api = z.number().int().positive();

/**
 * The local Spade the app reaches directly, with the identity of the daemon beside it
 * (`hostId`, its home's `host-id`): a window uses the direct path only while it shows that
 * daemon's machine. Null when there is none (or none it speaks to).
 */
export const SpadeEndpointInfo = z
  .object({
    address: z.string().max(64),
    version: Version,
    api: Api,
    hostId: z.string().min(1).max(128),
  })
  .nullable();
export type SpadeEndpointInfo = z.infer<typeof SpadeEndpointInfo>;

/** `GET /health`: null when nothing answers at Spade's address. */
export const SpadeHealthInfo = z
  .object({ version: Version.optional(), api: Api.optional() })
  .nullable();
export type SpadeHealthInfo = z.infer<typeof SpadeHealthInfo>;

/** One request to Spade's API; the main process adds the token. */
export const SpadeDirectRequest = z.object({
  method: SpadeMethod,
  path: z.string().min(1).max(2048),
  /** The whole body, sent as one request: a message with eight images fits. */
  body: z.string().max(maxSpadeUploadBytes).optional(),
  contentType: z.string().max(256).optional(),
});
export type SpadeDirectRequest = z.infer<typeof SpadeDirectRequest>;

const ContentType = z.string().max(256).optional();
const Status = z.number().int().min(100).max(599);

export const SpadeDirectAnswer = z.discriminatedUnion("kind", [
  /** Spade answered: JSON and text as text, anything else (an image) as bytes. */
  z.object({ kind: z.literal("text"), status: Status, contentType: ContentType, body: z.string() }),
  z.object({
    kind: z.literal("bytes"),
    status: Status,
    contentType: ContentType,
    body: z.instanceof(Uint8Array),
  }),
  /** No Spade listened, or none is known: nothing was sent, so another path may send it. */
  z.object({ kind: z.literal("unreachable") }),
  /** Refused here, or cut off after it may have reached Spade (`failed`). */
  z.object({
    kind: z.literal("error"),
    code: z.enum(["invalid_path", "too_large", "failed"]),
    message: z.string().max(2000),
  }),
]);
export type SpadeDirectAnswer = z.infer<typeof SpadeDirectAnswer>;

const StreamId = z.string().min(1).max(128);

/** Open a live stream (a `/v1/.../live?after=N` path); its frames come as `spade.live` events. */
export const SpadeLiveOpen = z.object({ streamId: StreamId, path: z.string().min(1).max(2048) });
export const SpadeLiveClose = z.object({ streamId: StreamId });

export const SpadeLiveEndReason = z.enum([
  /** Spade closed the stream (a restart, say): open again after the last `seq`. */
  "closed",
  /** Nothing listened at Spade's address: the stream never opened. */
  "unreachable",
  /** Spade refused the stream; `status` says how. */
  "refused",
  "too_large",
  "invalid_path",
  "limit",
]);
export type SpadeLiveEndReason = z.infer<typeof SpadeLiveEndReason>;

export const SpadeLiveEvent = z.discriminatedUnion("kind", [
  z.object({
    streamId: StreamId,
    kind: z.literal("frame"),
    event: z.string().max(128),
    data: z.string().max(maxSpadeResponseBytes),
  }),
  z.object({
    streamId: StreamId,
    kind: z.literal("ended"),
    reason: SpadeLiveEndReason,
    status: Status.optional(),
  }),
]);
export type SpadeLiveEvent = z.infer<typeof SpadeLiveEvent>;
