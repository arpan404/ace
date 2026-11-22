import { z } from "zod";
import { ThreadId } from "./ids.ts";

/** Repository-relative path without NUL bytes. */
const repoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"))
  .meta({ "x-ace-constraint": "Repository-relative path without NUL bytes." });

/** Maximum path entries per source control status section. */
export const sourceControlStatusLimit = 500;

/** One file entry inside a staged, unstaged, untracked or conflicted section of `git.status`. */
export const GitStatusSectionEntry = z.object({
  path: repoPath,
  /** A rename's old path. */
  from: repoPath.optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked", "conflicted"]),
  /** The file as this status read it; a commit of it quotes it back (`reviewed`). */
  fingerprint: z.string().min(1).max(200),
});
export type GitStatusSectionEntry = z.infer<typeof GitStatusSectionEntry>;

export const GitSourceControlCommands = [
  z.object({
    type: z.literal("git.stage"),
    threadId: ThreadId,
    /** Stage only these repository-relative paths; stage every change when absent. */
    paths: z
      .array(repoPath)
      .min(1)
      .max(2 * sourceControlStatusLimit)
      .optional(),
  }),
  z.object({
    type: z.literal("git.unstage"),
    threadId: ThreadId,
    /** Unstage only these repository-relative paths; unstage every staged change when absent. */
    paths: z
      .array(repoPath)
      .min(1)
      .max(2 * sourceControlStatusLimit)
      .optional(),
  }),
  z.object({
    type: z.literal("git.fetch"),
    threadId: ThreadId,
    remote: z.string().min(1).max(128).optional(),
  }),
] as const;
