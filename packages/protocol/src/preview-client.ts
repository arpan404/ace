import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { PreviewDescriptor, PreviewPort } from "./preview.ts";
const id = z.string().min(1).max(128);
export const PreviewRequest = z.object({
  type: z.literal("preview.request"),
  requestId: id,
  threadId: ThreadId,
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("list") }),
    z.object({ op: z.literal("forward"), port: PreviewPort }),
    z.object({ op: z.literal("unforward"), port: PreviewPort }),
    /** A single-use sign-in link for a port this thread previews (needs `operate`). */
    z.object({ op: z.literal("link"), port: PreviewPort }),
  ]),
});
/**
 * A preview's sign-in link: load it (in a frame or a browser) to receive a session cookie for
 * the preview origin. It works once, within a minute; the session lasts `sessionMs`, and a
 * client keeps it by redeeming a fresh link before then.
 */
export const PreviewLink = z.object({
  url: z.url().max(4096),
  sessionMs: z.number().int().positive(),
});
/**
 * Why the daemon refused a preview request. `error` stays a free string so older clients keep
 * decoding newer codes; these are the ones the daemon sends today.
 */
export const PreviewErrorCode = z.enum([
  "forbidden",
  "preview_unavailable",
  "preview_not_found",
  "preview_owned_by_another_thread",
  "preview_limit",
  "preview_link_refused",
  "preview_refused",
]);
export const PreviewResult = z.object({
  type: z.literal("preview.result"),
  requestId: id,
  ok: z.boolean(),
  error: z.string().max(128).optional(),
  previews: z.array(PreviewDescriptor).max(64).optional(),
  link: PreviewLink.optional(),
});

export type PreviewRequest = z.infer<typeof PreviewRequest>;
export type PreviewResult = z.infer<typeof PreviewResult>;
export type PreviewLink = z.infer<typeof PreviewLink>;
export type PreviewErrorCode = z.infer<typeof PreviewErrorCode>;
