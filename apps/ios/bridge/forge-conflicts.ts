import { ClientError } from "@ace/client";
import {
  ForgeRepository,
  maxConflictFileBytes,
  ThreadId,
  WorkspaceActionRequest,
  type CommandResult,
  type ForgePrDetail,
  type ForgePrRef,
  type GitConflicts,
  type GitConflictStep,
} from "@ace/protocol";
import {
  conflictHunks,
  conflictRefusalText,
  conflictRequest,
  editDraft,
  outcomeUncertain,
  resolveHunk,
  type HunkChoice,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prDetail } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";

/*
 * A pull request's merge conflicts, resolved from the phone in a linked thread's checkout of it,
 * as the web's PR panel resolves them: merge the base in, settle each file hunk by hunk (ours,
 * theirs, both, or the person's own text) or hand it to the agent, then commit and push the head
 * branch, or abort. Each step is one daemon command; the conflicts are read again after it.
 */

const sha = z.string().regex(/^[a-f0-9]{40,64}$/);
const target = {
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
  /** The thread whose checkout resolves; the first linked one when omitted. */
  threadId: z.string().min(1).max(256).optional(),
};
const path = z.string().min(1).max(4096);
export const ForgeConflictsRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forge.pull.conflicts"), ...target }),
  z.object({
    type: z.literal("forge.conflicts"),
    ...target,
    repository: ForgeRepository,
    threadId: z.string().min(1).max(256),
    step: z.discriminatedUnion("action", [
      z.object({ action: z.literal("start"), head: sha }),
      z.object({ action: z.literal("abort") }),
      z.object({ action: z.literal("take"), path, side: z.enum(["ours", "theirs"]) }),
      z.object({
        action: z.literal("resolve"),
        path,
        /** The file as the person saw it; one changed since refuses the write. */
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        hunk: z.number().int().nonnegative(),
        choice: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("ours") }),
          z.object({ kind: z.literal("theirs") }),
          z.object({ kind: z.literal("both") }),
          z.object({ kind: z.literal("edit"), text: z.string().max(maxConflictFileBytes) }),
        ]),
      }),
      z.object({ action: z.literal("finish"), head: sha }),
      z.object({ action: z.literal("push") }),
    ]),
  }),
]);
export type ForgeConflictsRequest = z.infer<typeof ForgeConflictsRequest>;

export interface ConflictFile {
  path: string;
  /** Why only a whole side can be taken, or null for a text file with hunks. */
  unavailable: string | null;
  revision: string | null;
  hunks: { ours: string; theirs: string; base: string | null; draft: string }[];
  /** What "Ask the agent" puts in the thread's composer. */
  request: string;
}
export interface ConflictsReply {
  type: "forge.pull.conflicts";
  threads: { id: string; title: string }[];
  threadId: string | null;
  baseBranch: string;
  headBranch: string;
  /** The checkout's state: null when it doesn't hold this pull request. */
  checkout: {
    head: string | null;
    merging: boolean;
    dirty: boolean;
    files: ConflictFile[];
    truncated: boolean;
  } | null;
  /** Why the checkout can't be read, in words; null when it was. */
  note: string | null;
}
export interface ConflictsWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  uncertain: boolean;
}

const unavailableWords = {
  binary: "Binary file: take one side.",
  too_large: "Too large to show: take one side.",
  missing: "One side deleted it: take one side.",
  unsupported: "Not a regular file: take one side.",
} as const;

async function readConflicts(
  owner: ForgeOwner,
  threadId: string,
  pr: ForgePrRef,
  signal?: AbortSignal,
): Promise<GitConflicts | null> {
  const reply = await owner.request(
    WorkspaceActionRequest.parse({
      type: "workspace.request",
      requestId: "forge-conflicts",
      operation: { op: "git.conflicts", threadId: ThreadId.parse(threadId), pr },
    }),
    { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
  );
  if (reply.result.kind === "error") throw new ForgeRefusal(reply.result.code);
  if (reply.result.kind !== "gitConflicts") throw new ForgeRefusal("forge_invalid_data");
  return reply.result.conflicts;
}

const linkedThreads = (detail: ForgePrDetail) =>
  detail.relatedThreads.filter((thread) => !thread.archived);

export async function readPullConflicts(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeConflictsRequest, { type: "forge.pull.conflicts" }>,
  preview: Preview,
): Promise<ConflictsReply> {
  const detail = await prDetail(reads, request);
  const threads = linkedThreads(detail);
  const threadId = threads.find((thread) => thread.id === request.threadId)?.id ?? threads[0]?.id;
  const base = {
    type: "forge.pull.conflicts" as const,
    threads: threads.map((thread) => ({ id: thread.id, title: preview(thread.title, 200) })),
    threadId: threadId ?? null,
    baseBranch: preview(detail.baseBranch, 256),
    headBranch: preview(detail.headBranch, 256),
  };
  if (!threadId)
    return {
      ...base,
      checkout: null,
      note: "Link a thread to this pull request to resolve its conflicts.",
    };
  let conflicts: GitConflicts | null;
  try {
    conflicts = await readConflicts(owner, threadId, detail.status.ref);
  } catch (error) {
    const code =
      error instanceof ForgeRefusal || error instanceof ClientError ? error.code : undefined;
    return { ...base, checkout: null, note: conflictRefusalText(code, detail.headBranch) };
  }
  if (!conflicts)
    return {
      ...base,
      checkout: null,
      note: conflictRefusalText("git_pr_head_unavailable", detail.headBranch),
    };
  return {
    ...base,
    checkout: {
      head: conflicts.head,
      merging: conflicts.merging,
      dirty: conflicts.dirty,
      truncated: conflicts.truncated,
      files: conflicts.files.map((file) => ({
        path: file.path,
        unavailable:
          file.content.kind === "unavailable" ? unavailableWords[file.content.reason] : null,
        revision: file.content.kind === "text" ? file.content.revision : null,
        hunks:
          file.content.kind === "text"
            ? conflictHunks(file.content.segments).map(({ hunk }) => ({
                ours: hunk.ours,
                theirs: hunk.theirs,
                base: hunk.base,
                draft: editDraft(hunk),
              }))
            : [],
        request: conflictRequest({
          path: file.path,
          number: detail.status.ref.number,
          baseBranch: detail.baseBranch,
          headBranch: detail.headBranch,
        }),
      })),
    },
    note: null,
  };
}

const write = (ok: boolean, message: string, uncertain = false): ConflictsWriteReply => ({
  type: "forge.write",
  ok,
  message,
  uncertain,
});

export async function writeConflicts(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeConflictsRequest, { type: "forge.conflicts" }>,
): Promise<ConflictsWriteReply> {
  const pr = { repository: request.repository, number: request.number };
  const threadId = ThreadId.parse(request.threadId);
  const detail = await prDetail(reads, request);
  const refused = (result: CommandResult | undefined, error?: unknown) => {
    const code =
      result?.error ??
      (error instanceof ClientError || error instanceof ForgeRefusal ? error.code : undefined);
    return write(false, conflictRefusalText(code, detail.headBranch), outcomeUncertain(code));
  };
  const run = async (step: GitConflictStep) => {
    try {
      const result = await owner.command({ type: "git.conflicts", threadId, pr, step });
      return result.ok ? { result } : { failed: refused(result) };
    } catch (error) {
      return { failed: refused(undefined, error) };
    }
  };
  const push = async () => {
    try {
      // Pushes the head branch without force: a branch that moved on GitHub refuses.
      const result = await owner.command({ type: "git.push", threadId, remote: "origin" });
      reads.forget(request.project);
      return result.ok ? write(true, `Pushed the merge to ${detail.headBranch}`) : refused(result);
    } catch (error) {
      return refused(undefined, error);
    }
  };
  const step = request.step;
  if (step.action === "push") return push();
  if (step.action === "finish") {
    const done = await run({ action: "commit", expectedHead: step.head });
    return done.failed ?? push();
  }
  if (step.action === "resolve") {
    // The file is read again: the hunk resolves against the text it was chosen from.
    const conflicts = await readConflicts(owner, request.threadId, pr);
    const file = conflicts?.files.find((each) => each.path === step.path);
    if (!file || file.content.kind !== "text" || file.content.revision !== step.revision)
      return write(false, conflictRefusalText("git_head_moved", detail.headBranch));
    const choice: HunkChoice = step.choice;
    const content = resolveHunk(file.content.segments, step.hunk, choice);
    const done = await run({ action: "write", path: step.path, content, revision: step.revision });
    return done.failed ?? write(true, "");
  }
  const done = await run(
    step.action === "start"
      ? { action: "start", expectedHead: step.head }
      : step.action === "abort"
        ? { action: "abort" }
        : { action: "take", path: step.path, side: step.side },
  );
  if (done.failed) return done.failed;
  if (step.action === "start" && done.result.code === "merge_up_to_date")
    return write(true, `Already up to date with ${detail.baseBranch}`);
  return write(true, step.action === "abort" ? "Merge aborted" : "");
}
