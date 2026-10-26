import {
  ForgeHostedReviewCommand,
  ForgeRepository,
  ForgeReviewAction,
  WorkspaceId,
} from "@ace/protocol";
import { actionErrorText, lockedKinds, lockedText, reviewLostText } from "@ace/ui-core";
import { z } from "zod";
import { shownKey, type ShownBodies } from "./forge-conversation.ts";
import { lockedOut, prLifecycle } from "./forge-pr-reads.ts";
import type { ForgeOwner, ForgeReads } from "./forge-reads.ts";

/*
 * One review write on a pull request (`forge.hosted.review`), as the web's PR page sends it:
 * refused on a conversation locked to this account, sent once and never again on its own, and
 * a lost answer said to be uncertain so the person reconciles it. An edit or delete expects the
 * text the phone last showed, so a comment changed elsewhere since is never overwritten.
 */

export const ForgeReviewRequest = z.object({
  type: z.literal("forge.review"),
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository,
  /**
   * A review action. A draft without an id is given one; an edit or delete names no expected
   * text, which comes from what the phone was shown.
   */
  action: z.record(z.string(), z.unknown()),
});
export type ForgeReviewRequest = z.infer<typeof ForgeReviewRequest>;

export interface ReviewWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  /** GitHub's answer was lost: the write may have happened. Reconcile, never resend. */
  uncertain: boolean;
}

const Source = z.enum(["issue", "inline"]);
const Pinned = z.object({ commentId: z.number().int().positive(), source: Source });
const shownFirst = "Refresh to see the latest version of this comment first.";

const refuse = (message: string): ReviewWriteReply => ({
  type: "forge.write",
  ok: false,
  message,
  uncertain: false,
});

/** The action as the protocol takes it, its id and expected text filled in. */
function completed(
  raw: Record<string, unknown>,
  shown: ShownBodies,
  newId: () => string,
): ForgeReviewAction | string {
  const action = { ...raw };
  if (action.kind === "draft.save") {
    const draft = z.record(z.string(), z.unknown()).safeParse(action.draft).data ?? {};
    action.draft = { id: newId(), ...draft };
  }
  if (action.kind === "comment.edit" || action.kind === "comment.delete") {
    const pinned = Pinned.safeParse(action);
    const expected = pinned.success
      ? shown.get(shownKey(pinned.data.source, pinned.data.commentId))
      : undefined;
    if (expected === undefined) return shownFirst;
    // The daemon keeps ace's publication marker on a comment ace posted.
    action.expectedBody = expected;
  }
  const parsed = ForgeReviewAction.safeParse(action);
  return parsed.success ? parsed.data : "That change can't be sent. Check it and try again.";
}

export async function writeReview(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeReviewRequest,
  shown: ShownBodies,
  newId: () => string,
): Promise<ReviewWriteReply> {
  const action = completed(request.action, shown, newId);
  if (typeof action === "string") return refuse(action);
  // A locked conversation refuses comments from someone who can't push: say so, send nothing.
  if (lockedKinds.has(action.kind) && lockedOut(await prLifecycle(reads, request)))
    return refuse(lockedText);
  const command = ForgeHostedReviewCommand.parse({
    type: "forge.hosted.review",
    workspaceId: WorkspaceId.parse(request.project),
    pr: { repository: request.repository, number: request.number },
    action,
  });
  try {
    const result = await owner.command(command);
    reads.forget(request.project);
    if (!result.ok) return refuse(actionErrorText(result.error));
    return { type: "forge.write", ok: true, message: "", uncertain: false };
  } catch {
    // No answer: the write may have reached GitHub. It is reconciled, never sent again.
    reads.forget(request.project);
    return { type: "forge.write", ok: false, message: reviewLostText, uncertain: true };
  }
}
