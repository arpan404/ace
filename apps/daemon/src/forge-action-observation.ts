import { ForgeCommand, type ForgePrStatus } from "@ace/protocol";
import { z } from "zod";

export type RemoteForgeAction = Extract<
  z.infer<typeof ForgeCommand>,
  {
    type: "forge.pr.merge" | "forge.pr.auto-merge" | "forge.review.request" | "forge.comment.reply";
  }
>;

export const ForgeWriteReceipt = z.object({
  action: ForgeCommand.refine(
    (action) =>
      action.type !== "forge.pr.status" &&
      action.type !== "forge.pr.link" &&
      action.type !== "forge.pr.unlink" &&
      action.type !== "forge.pr.create",
  ),
  phase: z.enum(["pending", "accepted", "reconciled", "failed"]),
  actor: z.string().optional(),
  replyBaseline: z.array(z.number().int().positive()).optional(),
});
export type ForgeWriteReceipt = z.infer<typeof ForgeWriteReceipt>;

/** Absence is never proof that a write was rejected: GitHub may still be converging. */
export function observedWrite(receipt: ForgeWriteReceipt, status: ForgePrStatus): boolean {
  const action = receipt.action;
  if (action.type === "forge.pr.merge")
    return status.state === "merged" && status.headSha === action.headSha;
  if (action.type === "forge.comment.reply")
    return (
      receipt.actor !== undefined &&
      receipt.replyBaseline !== undefined &&
      status.comments.some(
        (comment) =>
          !receipt.replyBaseline?.includes(comment.id) &&
          comment.kind === "inline" &&
          comment.replyTo === action.commentId &&
          comment.body === action.body &&
          comment.author === receipt.actor,
      )
    );
  const raw = z
    .object({
      pr: z.looseObject({
        requested_reviewers: z.array(z.object({ login: z.string() })).optional(),
        auto_merge: z.object({ merge_method: z.string() }).nullable().optional(),
      }),
    })
    .safeParse(status.raw);
  if (action.type === "forge.review.request")
    return (
      raw.success &&
      action.reviewers.every((login) =>
        raw.data.pr.requested_reviewers?.some((reviewer) => reviewer.login === login),
      )
    );
  if (action.type === "forge.pr.auto-merge")
    return (
      status.headSha === action.headSha &&
      (status.state === "merged" ||
        (raw.success && raw.data.pr.auto_merge?.merge_method === action.method))
    );
  return false;
}
