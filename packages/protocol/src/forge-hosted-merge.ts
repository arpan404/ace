import { z } from "zod";
import { ForgePrRef } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";

/**
 * Merge a pull request of a project's repository, whether or not a thread is linked to it (the
 * Pull requests page). It shares `forge.pr.merge`'s journal and fence for that PR: GitHub merges
 * only `headSha`, and a write whose answer was lost is checked on GitHub, never sent again.
 */
export const ForgeHostedMergeCommand = z.object({
  type: z.literal("forge.hosted.merge"),
  workspaceId: WorkspaceId,
  pr: ForgePrRef,
  headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  method: z.enum(["merge", "squash", "rebase"]),
});
export type ForgeHostedMergeCommand = z.infer<typeof ForgeHostedMergeCommand>;

/**
 * Turn auto-merge on or off for a pull request of a project's repository, linked to a thread or
 * not. Like `forge.hosted.merge` it is pinned to the head the person saw and shares the PR's
 * merge journal and fence with the thread's `forge.pr.auto-merge` and merge-state changes.
 */
export const ForgeHostedMergeStateCommand = z.object({
  type: z.literal("forge.hosted.merge-state"),
  workspaceId: WorkspaceId,
  pr: ForgePrRef,
  headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  action: z.enum(["enable", "disable"]),
  method: z.enum(["merge", "squash", "rebase"]),
});
export type ForgeHostedMergeStateCommand = z.infer<typeof ForgeHostedMergeStateCommand>;
