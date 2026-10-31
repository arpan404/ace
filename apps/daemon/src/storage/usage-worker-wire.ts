import { z } from "zod";
import { StorageUsage } from "@ace/protocol";

/** Partial sizes are lower bounds. Repeating a scan starts over, without a resume cursor.
 * A broad directory past the shared descriptor helper's 10,000-name cap stays partial.
 */
export const UsageLimits = z.object({
  maxEntries: z.number().int().positive().max(1_000_000).default(250_000),
  maxMs: z.number().int().positive().max(30_000).default(10_000),
  maxDepth: z.number().int().positive().max(128).default(64),
});
export const UsageWorkerInput = z.object({
  op: z.literal("scan"),
  root: z.string().min(1).max(4096),
  limits: UsageLimits,
});
export const UsageWorkerRequest = z.discriminatedUnion("op", [
  UsageWorkerInput,
  z.object({ op: z.literal("cancel") }),
]);
export const UsageWorkerReply = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("usage"), usage: StorageUsage }),
  z.object({ kind: z.literal("error"), code: z.literal("storage_usage_failed") }),
]);
