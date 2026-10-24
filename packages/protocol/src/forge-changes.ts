import { z } from "zod";

const text = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
export const ForgeCommit = z.object({
  raw: z.unknown().optional(),
  sha,
  message: text,
  author: text,
  authorAvatarUrl: text.optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  date: text.nullable(),
  url: text,
});
export type ForgeCommit = z.infer<typeof ForgeCommit>;
export const ForgeFile = z.object({
  raw: z.unknown().optional(),
  path: text,
  previousPath: text.optional(),
  status: text,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(262_144).nullable(),
  truncated: z.boolean(),
});
export type ForgeFile = z.infer<typeof ForgeFile>;
