import { z } from "zod";
import { BrowserVideoCodec } from "@ace/protocol";
import type { CaptureEvents } from "./backend.ts";

/*
 * What the video encoder (`video-extension/offscreen.ts`, ADR 0088) reports about its captures,
 * wherever it runs: ace's Chrome sends these over a CDP binding (`chrome-video.ts`), the
 * desktop app over its backend socket (`embedded-video.ts`). Parsed here once for both.
 */

export const VideoEncoderEvent = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("chunk"),
    capture: z.string().max(256),
    encode: z.string().max(256),
    key: z.boolean(),
    codec: BrowserVideoCodec,
    codedWidth: z.number().int().min(2).max(8192),
    codedHeight: z.number().int().min(2).max(8192),
    description: z.base64().max(4096).optional(),
    age: z.number().finite().min(0).max(60_000).optional(),
  }),
  z.object({
    t: z.literal("audio"),
    capture: z.string().max(256),
    codec: BrowserVideoCodec,
    sampleRate: z.number().int().min(8_000).max(192_000),
    channels: z.number().int().min(1).max(8),
    age: z.number().finite().min(0).max(60_000),
  }),
  z.object({ t: z.literal("failed"), capture: z.string().max(256), encode: z.string().max(256) }),
  z.object({ t: z.literal("ended"), capture: z.string().max(256) }),
]);
export type VideoEncoderEvent = z.infer<typeof VideoEncoderEvent>;

/**
 * Hands one encoder event to its capture's listener: `bytes` are a chunk's (video or sound);
 * a chunk without them is dropped. An ended capture leaves `captures`. Unknown captures (one
 * closed meanwhile) are ignored.
 */
export function deliverVideoEvent(
  captures: Map<string, CaptureEvents>,
  event: VideoEncoderEvent,
  bytes: Uint8Array | undefined,
): void {
  const events = captures.get(event.capture);
  if (!events) return;
  if (event.t === "ended") {
    captures.delete(event.capture);
    events.ended();
    return;
  }
  if (event.t === "failed") return events.failed(event.encode);
  if (!bytes) return;
  if (event.t === "audio") {
    const { capture: _capture, t: _t, ...audio } = event;
    return events.audio?.({ ...audio, bytes });
  }
  const { description, capture: _capture, t: _t, ...chunk } = event;
  events.chunk({
    ...chunk,
    ...(description ? { description: new Uint8Array(Buffer.from(description, "base64")) } : {}),
    bytes,
  });
}
