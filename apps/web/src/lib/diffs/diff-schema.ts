import type { FileDiff } from "@ace/ui-core";
import { FileChange } from "@ace/protocol";
import { z } from "zod";

/** A file's changes as the diff worker receives them. */
export const FileChangesInput = z.object({ path: z.string(), changes: z.array(FileChange) });

const Line = z.object({
  kind: z.enum(["context", "add", "del"]),
  old: z.number().optional(),
  new: z.number().optional(),
  text: z.string(),
});
const Row = z.union([
  Line,
  z.object({
    kind: z.literal("fold"),
    count: z.number().nullable(),
    lines: z.array(Line).optional(),
  }),
]);
/** A computed diff, from the worker or the persistent cache (possibly an older build's). */
export const FileDiffShape = z.object({
  path: z.string(),
  movedFrom: z.string().optional(),
  status: z.enum(["added", "modified", "deleted", "moved"]),
  rows: z.array(Row),
  additions: z.number(),
  deletions: z.number(),
});
export const decodeFileDiff = (value: unknown): FileDiff => FileDiffShape.parse(value);
