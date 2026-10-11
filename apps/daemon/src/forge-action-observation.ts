import { mergeStateChangeObserved } from "@ace/forge";
import { ForgeCommand, type ForgePrStatus, type ForgeMergeState } from "@ace/protocol";
import { z } from "zod";

export type RemoteForgeAction = Extract<
  z.infer<typeof ForgeCommand>,
  {
    type:
      | "forge.pr.merge"
      | "forge.pr.auto-merge"
      | "forge.pr.merge-state.change"
      | "forge.review.request"
      | "forge.comment.reply";
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

export function observedMergeState(
  action: ForgeWriteReceipt["action"],
  state: ForgeMergeState,
): boolean {
  if (action.type !== "forge.pr.auto-merge" && action.type !== "forge.pr.merge-state.change")
    return false;
  return mergeStateChangeObserved(
    state,
    action.headSha,
    action.type === "forge.pr.auto-merge" ? "enable" : action.action,
    action.method,
  );
}

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
  if (status.mergeState && observedMergeState(action, status.mergeState)) return true;
  const raw = z
    .object({
      pr: z.looseObject({
        requested_reviewers: z.array(z.object({ login: z.string() })).optional(),
        auto_merge: z.object({ merge_method: z.string() }).nullable().optional(),
      }),
    })
    .safeParse(status.raw);
  if (action.type === "forge.review.request") {
    if (!raw.success) return false;
    const observed = new Set(
      raw.data.pr.requested_reviewers?.map((reviewer) => reviewer.login.toLowerCase()),
    );
    const requested = new Set(action.reviewers.map((login) => login.toLowerCase()));
    return [...requested].every((login) => observed.has(login));
  }
  if (action.type === "forge.pr.auto-merge")
    return (
      status.headSha === action.headSha &&
      (status.state === "merged" ||
        (raw.success && raw.data.pr.auto_merge?.merge_method === action.method))
    );
  return false;
}
