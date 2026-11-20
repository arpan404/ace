import { lineChanges, merge3 } from "@ace/editor";
import { z } from "zod";

/*
 * The merge's text work as one job shape, run in the merge worker or, for small texts or where
 * there is no Worker, in place. Both sides run the same Wasm functions.
 */

export const MergeJob = z.discriminatedUnion("op", [
  z.object({ op: z.literal("merge3"), base: z.string(), mine: z.string(), theirs: z.string() }),
  z.object({ op: z.literal("lineChanges"), before: z.string(), after: z.string() }),
]);
export type MergeJob = z.infer<typeof MergeJob>;

const Chunk = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clean"), text: z.string() }),
  z.object({ kind: z.literal("conflict"), base: z.string(), mine: z.string(), theirs: z.string() }),
]);
export const MergeReply = z.union([
  z.object({ clean: z.literal(true), text: z.string(), chunks: z.array(Chunk) }),
  z.object({ clean: z.literal(false), chunks: z.array(Chunk) }),
  z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
]);
export type MergeReply = z.infer<typeof MergeReply>;

/** Runs a job; the editor's Wasm must be loaded. */
export function runMergeJob(job: MergeJob): MergeReply {
  return job.op === "merge3"
    ? merge3(job.base, job.mine, job.theirs)
    : lineChanges(job.before, job.after);
}
