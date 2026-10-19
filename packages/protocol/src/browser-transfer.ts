import { z } from "zod";
import { ThreadId } from "./ids.ts";
import { BlobHash } from "./context.ts";

/*
 * Files moving between the person's device and a thread's browser on the daemon: a finished
 * download fetched to this device in chunks, and files dropped onto the page.
 */

const short = z.string().min(1).max(256);
const base = z.object({ requestId: short, threadId: ThreadId });
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** The most one `browser.download.read` returns. */
export const browserDownloadChunkMax = 1024 * 1024;
/** The most one dropped file may be (it is uploaded first as a thread attachment). */
export const browserDropFileMax = 32 * 1024 * 1024;

/** A piece of what a file is now; a changed file has another. */
export const BrowserFileValidator = z.string().min(1).max(128);

/**
 * Part of a finished download of this thread's browser, from `offset`. The bytes travel as a
 * binary stream message (`browser.download.chunk`) just before the reply; the reply says how
 * many there were. Pass the reply's `validator` back on the next read: a file that changed in
 * between is refused rather than spliced.
 */
export const BrowserDownloadReadMessage = base.extend({
  type: z.literal("browser.download.read"),
  downloadId: short,
  offset,
  length: z.number().int().min(1).max(browserDownloadChunkMax).default(browserDownloadChunkMax),
  validator: BrowserFileValidator.optional(),
});

/** The reply to `browser.download.read`. */
export const BrowserDownloadRead = z.object({
  downloadId: short,
  offset,
  /** Bytes in this chunk's stream message. */
  bytes: z.number().int().nonnegative().max(browserDownloadChunkMax),
  /** The whole file's size. */
  size: offset,
  validator: BrowserFileValidator,
  /** This chunk reaches the end of the file. */
  done: z.boolean(),
});
export type BrowserDownloadRead = z.infer<typeof BrowserDownloadRead>;

/**
 * Files the person dropped on the page at (`x`, `y`) in the page's CSS pixels, uploaded first
 * as thread attachments. The page gets them as a native drag and drop there, so its own drop
 * zones take them.
 */
export const BrowserFilesDropMessage = base.extend({
  type: z.literal("browser.files.drop"),
  tabId: short,
  x: z.number().finite().min(0).max(100_000),
  y: z.number().finite().min(0).max(100_000),
  /** Keys held during the drop: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  modifiers: z.number().int().min(0).max(15).default(0),
  files: z
    .array(z.object({ sha256: BlobHash, name: z.string().min(1).max(255) }))
    .min(1)
    .max(16),
});
