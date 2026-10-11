import { z } from "zod";
import { ForgePrRef } from "./forge.ts";
import { WorkspaceId } from "./ids.ts";
const id = z.string().min(1).max(256);
const body = z.string().max(60_000);
const hostedBody = z.string().max(65_536);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
export const ForgeReviewAnchor = z.object({
  commit: sha,
  path: z.string().min(1).max(4096),
  line: z.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]),
  startLine: z.number().int().positive().optional(),
  startSide: z.enum(["LEFT", "RIGHT"]).optional(),
});
export type ForgeReviewAnchor = z.infer<typeof ForgeReviewAnchor>;
export const ForgeReviewDraft = z.object({ id, body, anchor: ForgeReviewAnchor });
export type ForgeReviewDraft = z.infer<typeof ForgeReviewDraft>;
export const ForgeReviewAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reconcile"), operationId: id }),
  z.object({ kind: z.literal("draft.save"), draft: ForgeReviewDraft }),
  z.object({ kind: z.literal("draft.delete"), id }),
  z.object({
    kind: z.literal("submit"),
    headSha: sha,
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
    body,
    draftIds: z.array(id).max(100),
  }),
  z.object({ kind: z.literal("conversation"), body: body.min(1) }),
  z.object({ kind: z.literal("reply"), commentId: z.number().int().positive(), body: body.min(1) }),
  z.object({
    kind: z.literal("comment.edit"),
    commentId: z.number().int().positive(),
    source: z.enum(["issue", "inline"]),
    expectedBody: hostedBody,
    body: body.min(1),
  }),
  z.object({
    kind: z.literal("comment.delete"),
    commentId: z.number().int().positive(),
    source: z.enum(["issue", "inline"]),
    expectedBody: hostedBody,
  }),
  z.object({ kind: z.literal("thread.resolve"), threadId: id }),
  z.object({ kind: z.literal("thread.unresolve"), threadId: id }),
  z.object({ kind: z.literal("file.view"), path: z.string().min(1).max(4096), headSha: sha }),
  z.object({ kind: z.literal("file.unview"), path: z.string().min(1).max(4096), headSha: sha }),
]);
export type ForgeReviewAction = z.infer<typeof ForgeReviewAction>;
export const ForgeHostedReviewCommand = z.object({
  type: z.literal("forge.hosted.review"),
  workspaceId: WorkspaceId,
  pr: ForgePrRef,
  action: ForgeReviewAction,
});
export const ForgeReviewState = z.object({
  viewer: id,
  headSha: sha,
  drafts: z.array(ForgeReviewDraft).max(100),
  viewed: z
    .array(z.object({ path: z.string().max(4096), state: z.string().max(100) }))
    .max(3000)
    .nullable(),
  canReview: z.boolean(),
  canComment: z.boolean(),
  resolvableThreads: z.array(id).max(2000),
  operations: z.array(z.object({ id, state: z.enum(["accepted", "uncertain"]) })).max(100),
});
export type ForgeReviewState = z.infer<typeof ForgeReviewState>;
