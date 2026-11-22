import { lineChanges, merge3 } from "@ace/editor";
import { extractSymbols, type OutlineSymbol } from "@ace/ui-core/editor-workbench";
import { z } from "zod";

/*
 * The editor worker's text jobs: 3-way merge, line diff, and document symbol outline.
 * Runs in `merge.worker.ts` off the main thread (or in place where there is no Worker).
 */

export const MergeJob = z.discriminatedUnion("op", [
  z.object({ op: z.literal("merge3"), base: z.string(), mine: z.string(), theirs: z.string() }),
  z.object({ op: z.literal("lineChanges"), before: z.string(), after: z.string() }),
  z.object({
    op: z.literal("outline"),
    text: z.string(),
    language: z.string().optional(),
  }),
]);
export type MergeJob = z.infer<typeof MergeJob>;

const Chunk = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clean"), text: z.string() }),
  z.object({ kind: z.literal("conflict"), base: z.string(), mine: z.string(), theirs: z.string() }),
]);

const SymbolKindSchema = z.enum([
  "function",
  "method",
  "class",
  "struct",
  "interface",
  "type",
  "enum",
  "const",
  "module",
  "heading",
]);

const OutlineSymbolSchema: z.ZodType<OutlineSymbol> = z.lazy(() =>
  z.object({
    name: z.string(),
    kind: SymbolKindSchema,
    line: z.number(),
    column: z.number(),
    endLine: z.number(),
    children: z.array(OutlineSymbolSchema),
  }),
);

export const MergeReply = z.union([
  z.object({ clean: z.literal(true), text: z.string(), chunks: z.array(Chunk) }),
  z.object({ clean: z.literal(false), chunks: z.array(Chunk) }),
  z.object({ op: z.literal("outline"), symbols: z.array(OutlineSymbolSchema) }),
  z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
]);
export type MergeReply = z.infer<typeof MergeReply>;

/** Runs a job; for `merge3` and `lineChanges`, the editor's Wasm must be loaded. */
export function runMergeJob(job: MergeJob): MergeReply {
  if (job.op === "merge3") return merge3(job.base, job.mine, job.theirs);
  if (job.op === "outline") {
    return { op: "outline", symbols: extractSymbols(job.text, job.language) };
  }
  return lineChanges(job.before, job.after);
}
