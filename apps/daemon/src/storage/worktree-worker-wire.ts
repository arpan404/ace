import { z } from "zod";

const path = z.string().min(1).max(4096);
export const WorktreeRequest = z.object({
  id: z.number().int().positive(),
  cancellation: z.instanceof(SharedArrayBuffer),
  operation: z.discriminatedUnion("op", [
    z.object({ op: z.literal("inspect"), repo: path, path }),
    z.object({ op: z.literal("backup"), repo: path, path }),
    z.object({
      op: z.literal("remove"),
      repo: path,
      path,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      force: z.boolean(),
      removeBranch: z.boolean(),
    }),
    z.object({ op: z.literal("close") }),
  ]),
});
export type WorktreeOperation = z.infer<typeof WorktreeRequest>["operation"];
export const WorktreeCheck = z.object({
  kind: z.literal("check"),
  id: z.number().int().positive(),
});
export const WorktreeState = z.object({
  path,
  head: z.string().nullable(),
  branch: z.string().nullable(),
  fingerprint: z.string(),
  bytes: z.number().nonnegative(),
  modifiedAt: z.number().nonnegative(),
  missing: z.boolean(),
  main: z.boolean(),
  locked: z.boolean(),
  dirty: z.boolean(),
  unpushed: z.boolean(),
  mergedIntoMain: z.boolean(),
});
export const WorktreeReply = z.object({
  id: z.number().int().positive(),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("state"), state: WorktreeState }),
    z.object({ kind: z.literal("backup"), head: z.string().nullable() }),
    z.object({ kind: z.literal("done") }),
    z.object({ kind: z.literal("error"), refused: z.boolean(), code: z.string().max(128) }),
  ]),
});
