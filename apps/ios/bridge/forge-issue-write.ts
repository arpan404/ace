import { CommandId, ForgeRepository, WorkspaceId, type CommandResult } from "@ace/protocol";
import { actionErrorText } from "@ace/ui-core";
import { z } from "zod";
import type { ForgeOwner, ForgeReads } from "./forge-reads.ts";

/*
 * Commenting on an issue from the phone, as the web's issue page does: each write has its own
 * command id, which the daemon journals, so one whose answer was lost is checked against GitHub
 * (reconcile) instead of being sent twice.
 */

export const ForgeIssueCommentRequest = z.object({
  type: z.literal("forge.issue.comment"),
  project: z.string().min(1).max(512),
  repository: ForgeRepository,
  number: z.number().int().positive(),
  body: z.string().min(1).max(64_000).regex(/\S/),
});
export const ForgeIssueReconcileRequest = z.object({
  type: z.literal("forge.issue.check"),
  project: z.string().min(1).max(512),
  repository: ForgeRepository,
  actionId: CommandId,
});
export type ForgeIssueCommentRequest = z.infer<typeof ForgeIssueCommentRequest>;
export type ForgeIssueReconcileRequest = z.infer<typeof ForgeIssueReconcileRequest>;

export interface IssueWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  uncertain: boolean;
}

const unconfirmed =
  "GitHub didn't confirm it. It may have gone through; check before trying again.";
const lostCodes = new Set(["action_outcome_uncertain", "forge_write_uncertain"]);

const reply = (ok: boolean, message: string, uncertain: boolean): IssueWriteReply => ({
  type: "forge.write",
  ok,
  message,
  uncertain,
});

function outcome(result: CommandResult | undefined): IssueWriteReply {
  const state = result?.issueAction?.state;
  if (!result || state === "uncertain" || state === "pending" || lostCodes.has(result.error ?? ""))
    return reply(false, unconfirmed, true);
  if (!result.ok || state === "failed")
    return reply(false, actionErrorText(result.issueAction?.error ?? result.error), false);
  return reply(true, "", false);
}

export async function commentOnIssue(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeIssueCommentRequest,
  newId: () => string,
): Promise<IssueWriteReply> {
  const result = await owner
    .command(
      {
        type: "forge.issue.write",
        workspaceId: WorkspaceId.parse(request.project),
        repository: request.repository,
        input: { action: "comment", number: request.number, body: request.body },
      },
      {},
      newId(),
    )
    .catch(() => undefined);
  reads.forget(request.project);
  return outcome(result);
}

export async function checkIssueWrite(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeIssueReconcileRequest,
): Promise<IssueWriteReply> {
  const result = await owner
    .command({
      type: "forge.issue.reconcile",
      workspaceId: WorkspaceId.parse(request.project),
      repository: request.repository,
      actionId: request.actionId,
    })
    .catch(() => undefined);
  reads.forget(request.project);
  return outcome(result);
}
