import {
  ForgeHostedLifecycleCommand,
  ForgeLifecycleAction,
  ForgeRepository,
  type CommandResult,
  type ForgeLifecycleState,
} from "@ace/protocol";
import {
  actionErrorText,
  issueStateMark,
  lifecycleLabels,
  lockReasonLabels,
  type ForgeMark,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prLifecycle, scopeOf } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";

/*
 * Managing a pull request from the phone, as the web's PR page does: its milestone, the issues
 * it closes, its head branch (delete, restore), and its conversation's lock. Every write names
 * the version of the pull request the person saw, so one changed elsewhere refuses it; a write
 * is sent once, and one GitHub hasn't confirmed waits to be reconciled.
 */

const target = {
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
};
export const ForgeManageRequest = z.object({
  type: z.literal("forge.pull.manage"),
  ...target,
  repository: ForgeRepository.optional(),
});
export type ForgeManageRequest = z.infer<typeof ForgeManageRequest>;

export const ForgeManageWriteRequest = z.object({
  type: z.literal("forge.manage"),
  ...target,
  repository: ForgeRepository,
  operation: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("apply"),
      version: z.string().regex(/^[a-f0-9]{64}$/),
      action: ForgeLifecycleAction,
    }),
    z.object({ kind: z.literal("reconcile"), operationId: z.string().min(1).max(256) }),
  ]),
});
export type ForgeManageWriteRequest = z.infer<typeof ForgeManageWriteRequest>;

export interface ManageReply {
  type: "forge.pull.manage";
  /** The version every write names. */
  version: string;
  milestone: { number: number; title: string } | null;
  /** Open milestones to choose from; null where the milestone can't be changed. */
  milestones: { number: number; title: string }[] | null;
  closingIssues: {
    number: number;
    title: string;
    state: ForgeMark;
    manual: boolean;
    url: string;
  }[];
  canLink: boolean;
  branch: {
    name: string;
    exists: boolean;
    delete: boolean;
    restore: boolean;
    note: string | null;
  } | null;
  conversation: { locked: boolean; reason: string | null; lock: boolean; unlock: boolean } | null;
  /** Writes GitHub hasn't confirmed, by what they were, to reconcile before anything else. */
  unconfirmed: { id: string; label: string }[];
  reasons: { value: string; label: string }[];
}

export interface ManageWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  uncertain: boolean;
}

function branchNote(snapshot: ForgeLifecycleState["snapshot"]): string | null {
  const branch = snapshot.headBranch;
  if (!branch) return null;
  if (branch.isDefault) return "The repository's default branch is never deleted.";
  if (!branch.sameRepository) return "The branch lives in a fork.";
  if (branch.usedBy?.length)
    return `Kept while ${branch.usedBy.map((number) => `#${number}`).join(", ")} use it.`;
  return null;
}

export async function readManage(
  reads: ForgeReads,
  request: ForgeManageRequest,
  preview: Preview,
): Promise<ManageReply> {
  const state = await prLifecycle(reads, request);
  if (!state) throw new ForgeRefusal("forge_unavailable");
  const { snapshot } = state;
  const editable = snapshot.editableFields.includes("milestone");
  const milestones = editable
    ? await reads
        .read({ op: "forge.repo.milestones", ...scopeOf(request) }, true)
        .then((value) => (value.resource === "repoMilestones" ? value.value : []))
        .catch(() => [])
    : null;
  return {
    type: "forge.pull.manage",
    version: snapshot.version,
    milestone: snapshot.milestone
      ? { number: snapshot.milestone.number, title: preview(snapshot.milestone.title, 200) }
      : null,
    milestones:
      milestones?.map((each) => ({ number: each.number, title: preview(each.title, 200) })) ?? null,
    closingIssues: (snapshot.closingIssues ?? []).map((issue) => ({
      number: issue.ref.number,
      title: preview(issue.title, 300),
      state: issueStateMark(issue.state),
      manual: issue.manual,
      url: issue.url,
    })),
    canLink: snapshot.actions.includes("issue.link"),
    branch: snapshot.headBranch
      ? {
          name: preview(snapshot.headBranch.name, 256),
          exists: snapshot.headBranch.exists,
          delete: snapshot.actions.includes("branch.delete"),
          restore: snapshot.actions.includes("branch.restore"),
          note: branchNote(snapshot),
        }
      : null,
    conversation: snapshot.conversation
      ? {
          locked: snapshot.conversation.locked,
          reason: snapshot.conversation.reason
            ? lockReasonLabels[snapshot.conversation.reason]
            : null,
          lock: snapshot.actions.includes("lock"),
          unlock: snapshot.actions.includes("unlock"),
        }
      : null,
    unconfirmed: state.operations
      .filter((op) => op.state === "pending" || op.state === "uncertain")
      .map((op) => ({
        id: op.id,
        label:
          op.kind in lifecycleLabels
            ? lifecycleLabels[op.kind as keyof typeof lifecycleLabels]
            : "Pull request change",
      })),
    reasons: Object.entries(lockReasonLabels).map(([value, label]) => ({ value, label })),
  };
}

const write = (ok: boolean, message: string, uncertain = false): ManageWriteReply => ({
  type: "forge.write",
  ok,
  message,
  uncertain,
});

/** What a lifecycle command's answer means for the person. */
export function lifecycleOutcome(result: CommandResult | undefined): ManageWriteReply {
  if (!result)
    return write(false, "Couldn't confirm the change. Check it before trying again.", true);
  if (!result.ok) return write(false, actionErrorText(result.error));
  const receipt = result.forgeLifecycle;
  if (!receipt)
    return write(false, "Couldn't confirm the change. Check it before trying again.", true);
  if (receipt.outcome === "pending") return write(false, "Waiting for GitHub to confirm it.", true);
  if (receipt.outcome === "head_changed")
    return write(false, "The branch head changed. Review its new commits before trying again.");
  return write(true, "");
}

export async function writeManage(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: ForgeManageWriteRequest,
): Promise<ManageWriteReply> {
  const operation = request.operation;
  const command = ForgeHostedLifecycleCommand.parse({
    type: "forge.hosted.lifecycle",
    workspaceId: request.project,
    pr: { repository: request.repository, number: request.number },
    operation:
      operation.kind === "apply"
        ? { kind: "apply", expectedVersion: operation.version, action: operation.action }
        : operation,
  });
  const result = await owner.command(command).catch(() => undefined);
  reads.forget(request.project);
  return lifecycleOutcome(result);
}
