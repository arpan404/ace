import { z } from "zod";
import type { CaptureEvents } from "./backend.ts";

/*
 * What the video encoder (`video-extension/offscreen.ts`, ADR 0088) reports about its captures,
 * wherever it runs: ace's Chrome sends these over a CDP binding (`chrome-video.ts`), the
 * desktop app over its backend socket (`embedded-video.ts`). Parsed here once for both. Chunks
 * never come this way: they go to ace-media's ingest. Unknown events (an older encoder's
 * `chunk`, `audio` or `moved`) fail to parse and are ignored.
 */

export const VideoEncoderEvent = z.discriminatedUnion("t", [
  z.object({ t: z.literal("failed"), capture: z.string().max(256), encode: z.string().max(256) }),
  z.object({
    t: z.literal("ended"),
    capture: z.string().max(256),
    reason: z.string().max(2048).optional(),
  }),
]);
export type VideoEncoderEvent = z.infer<typeof VideoEncoderEvent>;

/**
 * Hands one encoder event to its capture's listener. An ended capture leaves `captures`.
 * Unknown captures (one closed meanwhile) are ignored.
 */
export function deliverVideoEvent(
  captures: Map<string, CaptureEvents>,
  event: VideoEncoderEvent,
): void {
  const events = captures.get(event.capture);
  if (!events) return;
  if (event.t === "ended") {
    captures.delete(event.capture);
    events.ended(event.reason);
    return;
  }
  events.failed(event.encode);
}
