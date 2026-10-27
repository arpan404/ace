import { ClientError } from "@ace/client";
import {
  ForgeRepository,
  ThreadId,
  WorkspaceActionRequest,
  type ForgePrDetail,
} from "@ace/protocol";
import { actionErrorText, outcomeUncertain } from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prDetail } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";

/*
 * Working on a pull request from its page: each linked thread, and whether its checkout holds
 * the PR's current head; "Check out" prepares an isolated checkout of that head for the thread
 * (`forge.pr.worktree`, the web's "Work on PR in this task"), sent once. Each thread's checkout
 * is read from the daemon, never assumed from the write.
 */

const target = {
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
};
export const ForgeWorktreeRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forge.pull.work"), ...target }),
  z.object({
    type: z.literal("forge.worktree"),
    ...target,
    repository: ForgeRepository,
    threadId: z.string().min(1).max(256),
    headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/),
  }),
]);
export type ForgeWorktreeRequest = z.infer<typeof ForgeWorktreeRequest>;

export interface WorkReply {
  type: "forge.pull.work";
  headSha: string;
  /** Why no checkout can be prepared, or null when one can. */
  blocked: string | null;
  threads: {
    id: string;
    title: string;
    /** The thread's checkout holds this head; an older head says it needs updating. */
    checkout: "current" | "older" | null;
    branch: string | null;
  }[];
}

/** The thread's checkout as the daemon has it now: the head it holds and its branch. */
async function checkoutOf(
  owner: ForgeOwner,
  id: string,
  detail: ForgePrDetail,
): Promise<{ checkout: WorkReply["threads"][number]["checkout"]; branch: string | null }> {
  const reply = await owner
    .request(
      WorkspaceActionRequest.parse({
        type: "workspace.request",
        requestId: "forge-work",
        operation: { op: "thread.details", threadId: ThreadId.parse(id) },
      }),
      { timeoutMs: 15_000 },
    )
    .catch(() => undefined);
  const details = reply?.result.kind === "details" ? reply.result.details : undefined;
  const workspace = details?.pullRequestWorkspace;
  const ref = detail.status.ref;
  const same =
    workspace &&
    workspace.ref.number === ref.number &&
    workspace.ref.repository.owner.toLowerCase() === ref.repository.owner.toLowerCase() &&
    workspace.ref.repository.name.toLowerCase() === ref.repository.name.toLowerCase();
  return {
    checkout: same
      ? workspace.headSha.toLowerCase() === detail.status.headSha.toLowerCase()
        ? "current"
        : "older"
      : null,
    branch: details?.branch ?? null,
  };
}

export async function readWork(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeWorktreeRequest, { type: "forge.pull.work" }>,
  preview: Preview,
): Promise<WorkReply> {
  const detail = await prDetail(reads, request);
  const open = detail.status.state === "open" || detail.status.state === "draft";
  return {
    type: "forge.pull.work",
    headSha: detail.status.headSha,
    blocked: !detail.headRepository
      ? "The pull request's head repository is unavailable."
      : !open
        ? "Only an open pull request can be checked out."
        : null,
    threads: await Promise.all(
      detail.relatedThreads
        .filter((thread) => !thread.archived)
        .slice(0, 20)
        .map(async (thread) => {
          const { checkout, branch } = await checkoutOf(owner, thread.id, detail);
          return {
            id: thread.id,
            title: preview(thread.title, 200),
            checkout,
            branch: branch && preview(branch, 256),
          };
        }),
    ),
  };
}

export interface WorktreeWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  uncertain: boolean;
}

const reply = (ok: boolean, message: string, uncertain = false): WorktreeWriteReply => ({
  type: "forge.write",
  ok,
  message,
  uncertain,
});

export async function writeWorktree(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeWorktreeRequest, { type: "forge.worktree" }>,
): Promise<WorktreeWriteReply> {
  try {
    const result = await owner.command({
      type: "forge.pr.worktree",
      threadId: ThreadId.parse(request.threadId),
      pullRequest: {
        ref: { repository: request.repository, number: request.number },
        headSha: request.headSha,
      },
    });
    reads.forget(request.project);
    if (result.ok) return reply(true, "Checked out in the thread");
    return reply(
      false,
      actionErrorText(result.error ?? "action_failed"),
      outcomeUncertain(result.error),
    );
  } catch (error) {
    const code =
      error instanceof ClientError || error instanceof ForgeRefusal ? error.code : undefined;
    return reply(
      false,
      actionErrorText(code ?? "action_outcome_uncertain"),
      outcomeUncertain(code),
    );
  }
}
