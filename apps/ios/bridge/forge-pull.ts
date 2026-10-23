import { ClientError } from "@ace/client";
import {
  ForgeRepository,
  WorkspaceId,
  type CommandPayload,
  type ForgeMergeState,
  type ForgePrDetail,
} from "@ace/protocol";
import {
  actionErrorText,
  autoMergeBlocker,
  mergeBlockers,
  mergeMethods,
  noAutoMerge,
  prGates,
  prPrimaryAction,
  prPrimaryLabel,
  prTone,
  prWords,
  reviewerOutcomes,
  reviewOutcomeLabels,
  type ForgeMark,
  type MergeMethod,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";
import { keyOf, type ForgeLabelView } from "./forge-rows.ts";

/*
 * One pull request as the phone's page shows it: the header, the merge gates and the one
 * primary control the web's PR page offers (`prGates`, `prPrimaryAction`), its description,
 * people, checks, files and threads. Merge and auto-merge go through the PR's linked thread
 * when one exists, else through its project (`forge.hosted.*`), pinned to the head shown.
 */

const method = z.enum(["squash", "merge", "rebase"]);
const sha = z.string().regex(/^[a-fA-F0-9]{40,64}$/);
const target = {
  project: z.string().min(1).max(512),
  number: z.number().int().positive(),
  repository: ForgeRepository,
};
export const ForgePullRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("forge.pull"),
    ...target,
    /** Another repository than the project's own; omitted for the project's. */
    repository: ForgeRepository.optional(),
    method: method.default("squash"),
  }),
  z.object({ type: z.literal("forge.merge"), ...target, method, headSha: sha }),
  z.object({
    type: z.literal("forge.auto-merge"),
    ...target,
    method,
    headSha: sha,
    action: z.enum(["enable", "disable"]),
  }),
]);
export type ForgePullRequest = z.infer<typeof ForgePullRequest>;

export interface PullAction {
  kind: "merge" | "enable-auto-merge" | "disable-auto-merge";
  label: string;
  /** Why it can't be pressed now, in the web's words. */
  disabled: string | null;
}
export interface PullReply {
  type: "forge.pull";
  number: number;
  repository: ForgeRepository;
  title: string;
  url: string;
  state: ForgeMark;
  merged: boolean;
  author: string;
  createdAt: number | null;
  updatedAt: number | null;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  additions: number | null;
  deletions: number | null;
  commits: number;
  changedFiles: number;
  body: string;
  labels: ForgeLabelView[];
  gates: { label: string; value: string; detail: string | null; tone: string }[];
  /** The primary control's words ("Squash and merge", "Merge blocked"); empty when none. */
  primary: string;
  /** What the primary control does, when it does something the phone can send. */
  action: PullAction | null;
  /** Turning auto-merge off, while it is on and GitHub lets this account. */
  secondary: PullAction | null;
  blockers: string[];
  methods: { method: MergeMethod; label: string }[];
  method: MergeMethod;
  reviewers: { login: string; outcome: string | null }[];
  checks: { name: string; tone: string; word: string }[];
  files: { path: string; additions: number; deletions: number; status: string }[];
  threads: { id: string; title: string; archived: boolean; needsYou: boolean }[];
}

const epoch = (at: string | undefined) => {
  const parsed = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const checkWords = {
  success: { word: "Passed", tone: "done" },
  failure: { word: "Failing", tone: "failed" },
  pending: { word: "Running", tone: "working" },
  cancelled: { word: "Cancelled", tone: "idle" },
  unknown: { word: "Unknown", tone: "idle" },
} as const;
const fence = "Refresh GitHub to confirm the previous change first";

type PageTarget = { project: string; number: number; repository?: ForgeRepository | undefined };
const scopeOf = (request: PageTarget) => ({
  workspaceId: request.project,
  ...(request.repository ? { repository: request.repository } : {}),
  number: request.number,
});

async function readDetail(reads: ForgeReads, request: PageTarget) {
  const value = await reads.read({ op: "forge.pr.detail", ...scopeOf(request) }, false);
  if (value.resource !== "prDetail") throw new ForgeRefusal("forge_invalid_data");
  return value.value;
}

async function readMergeState(
  reads: ForgeReads,
  request: PageTarget,
  detail: ForgePrDetail,
): Promise<ForgeMergeState | undefined> {
  if (detail.status.state !== "open" && detail.status.state !== "draft") return undefined;
  try {
    const value = await reads.read({ op: "forge.pr.merge-state", ...scopeOf(request) }, false);
    return value.resource === "prMergeState" ? value.value : undefined;
  } catch {
    // The page still shows without it; merge-state writes then say it is unavailable.
    return undefined;
  }
}

export async function readPull(
  reads: ForgeReads,
  request: Extract<ForgePullRequest, { type: "forge.pull" }>,
  preview: Preview,
): Promise<PullReply> {
  const detail = await readDetail(reads, request);
  const mergeState = await readMergeState(reads, request, detail);
  const { status } = detail;
  const state = status.state === "unknown" ? "open" : status.state;
  const outcomes = reviewerOutcomes(status.comments);
  const gates = prGates({
    status,
    reviewDecision: detail.reviewDecision,
    mergeState,
    baseBranch: detail.baseBranch,
    outcomes,
  });
  const blockers = mergeBlockers(gates);
  // Outside a thread a PR merges through its project, linked or not (the web's Pull requests page).
  const primary = prPrimaryAction({
    status,
    mergeState,
    method: request.method,
    linked: true,
    autoMerge: true,
    blockers,
  });
  const fenced = detail.writeState !== undefined || mergeState?.writeState !== undefined;
  const label = prPrimaryLabel(primary);
  const action: PullAction | null =
    primary.kind === "merge"
      ? { kind: "merge", label, disabled: fenced ? fence : null }
      : primary.kind === "auto-merge" || primary.kind === "auto-merge-ready"
        ? {
            kind: "enable-auto-merge",
            label,
            disabled: fenced ? fence : (autoMergeBlocker(mergeState) ?? null),
          }
        : null;
  const secondary: PullAction | null =
    primary.kind === "auto-merge-armed" && mergeState?.canDisable
      ? {
          kind: "disable-auto-merge",
          label: "Turn off auto-merge",
          disabled: fenced ? fence : null,
        }
      : null;
  const live = reads.linked().pulls.get(keyOf(status));
  return {
    type: "forge.pull",
    number: status.ref.number,
    repository: status.ref.repository,
    title: preview(status.title, 400),
    url: status.url,
    state: { word: prWords[state], tone: prTone[state] },
    merged: state === "merged",
    author: preview(detail.author, 100),
    createdAt: epoch(detail.createdAt),
    updatedAt: epoch(detail.updatedAt),
    headBranch: preview(detail.headBranch, 256),
    baseBranch: preview(detail.baseBranch, 256),
    headSha: status.headSha,
    additions: detail.additions ?? null,
    deletions: detail.deletions ?? null,
    commits: detail.commits,
    changedFiles: detail.changedFiles,
    body: preview(detail.body, 32_768),
    labels: detail.labels.slice(0, 20).map((name) => ({
      name: preview(name, 100),
      color: detail.labelColors?.[name] ?? null,
    })),
    gates: gates.map((gate) => ({
      label: gate.label,
      value: preview(gate.value, 200),
      detail: gate.detail ?? null,
      tone: gate.tone,
    })),
    primary: label,
    action,
    secondary,
    blockers: primary.kind === "blocked" ? primary.blockers : [],
    methods: mergeMethods.map((each) => ({ method: each.method, label: each.label })),
    method: request.method,
    reviewers: [...new Set([...detail.reviewers, ...outcomes.keys()])].slice(0, 30).map((login) => {
      const outcome = outcomes.get(login);
      return { login: preview(login, 100), outcome: outcome ? reviewOutcomeLabels[outcome] : null };
    }),
    checks: status.checks.slice(0, 100).map((check) => ({
      name: preview(check.name, 200),
      word: checkWords[check.status].word,
      tone: checkWords[check.status].tone,
    })),
    files: (detail.files ?? []).map((file) => ({
      path: preview(file.path, 1024),
      additions: file.additions,
      deletions: file.deletions,
      status: file.status,
    })),
    threads: detail.relatedThreads.slice(0, 20).map((thread) => ({
      id: thread.id,
      title: preview(thread.title, 200),
      archived: thread.archived,
      needsYou: live?.id === thread.id && live.needsYou,
    })),
  };
}

/** What a refused or lost write means, in the web's words. */
function failure(error: unknown, autoMergeOn: boolean): string {
  const code =
    error instanceof ForgeRefusal || error instanceof ClientError ? error.code : undefined;
  if (autoMergeOn && code === "forge_forbidden") return noAutoMerge;
  return actionErrorText(code ?? "action_outcome_uncertain");
}

/** Merge or switch auto-merge; resolves with what to tell the person, the outcome included. */
export async function writePull(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Exclude<ForgePullRequest, { type: "forge.pull" }>,
): Promise<{ ok: boolean; message: string }> {
  const pr = { repository: request.repository, number: request.number };
  const thread = reads.linked().pulls.get(keyOf({ ref: pr }));
  const link = thread ? { threadId: thread.id, pr } : undefined;
  const workspaceId = WorkspaceId.parse(request.project);
  const payload: CommandPayload =
    request.type === "forge.merge"
      ? link
        ? { type: "forge.pr.merge", link, headSha: request.headSha, method: request.method }
        : {
            type: "forge.hosted.merge",
            workspaceId,
            pr,
            headSha: request.headSha,
            method: request.method,
          }
      : link
        ? {
            type: "forge.pr.merge-state.change",
            link,
            headSha: request.headSha,
            action: request.action,
            method: request.method,
          }
        : {
            type: "forge.hosted.merge-state",
            workspaceId,
            pr,
            headSha: request.headSha,
            action: request.action,
            method: request.method,
          };
  const enabling = request.type === "forge.auto-merge" && request.action === "enable";
  try {
    const result = await owner.command(payload);
    // A merge moves the PR between the lists' states: read them again next time.
    reads.forget(request.project);
    if (!result.ok)
      return { ok: false, message: failure(new ForgeRefusal(result.error ?? ""), enabling) };
    return {
      ok: true,
      message:
        request.type === "forge.merge"
          ? "Merged"
          : request.action === "enable"
            ? "Auto-merge on"
            : "Auto-merge off",
    };
  } catch (error) {
    reads.forget(request.project);
    return { ok: false, message: failure(error, enabling) };
  }
}
