import { z } from "zod";
import { ThreadId } from "./ids.ts";

/**
 * Which threads have an agent working in their browser right now, for the task list's
 * indicator. A client asks once per connection; the daemon answers with the whole set and
 * sends it again whenever it changes, limited to threads the client may read.
 */
export const BrowserBrowsingWatch = z.object({
  type: z.literal("browser.browsing.watch"),
  requestId: z.string().min(1).max(128),
});
export type BrowserBrowsingWatch = z.infer<typeof BrowserBrowsingWatch>;
export const BrowserBrowsing = z.object({
  type: z.literal("browser.browsing"),
  threads: z.array(ThreadId).max(512),
});
export type BrowserBrowsing = z.infer<typeof BrowserBrowsing>;
