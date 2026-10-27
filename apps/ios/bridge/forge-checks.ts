import { ClientError } from "@ace/client";
import {
  ForgeCheckAction,
  ForgeHostedChecksCommand,
  ForgeRepository,
  WorkspaceId,
  type ForgeCheckRun,
  type ForgeCheckStep,
  type ForgePrDetail,
  type VerifyOperation,
  type VerifyResult,
} from "@ace/protocol";
import {
  actionErrorText,
  checkControls,
  checkFixRequest,
  checkLogNote,
  checkLook,
  checkRunId,
  fileAnnotation,
  latestLocalCheck,
  localCheckAction,
  localCheckLook,
  outcomeUncertain,
} from "@ace/ui-core";
import { z } from "zod";
import type { Preview } from "./agents.ts";
import { prDetail } from "./forge-pr-reads.ts";
import { ForgeRefusal, type ForgeOwner, type ForgeReads } from "./forge-reads.ts";
import { LogPages, type LogPage } from "./forge-log-pages.ts";

/*
 * A pull request's checks as the phone's page shows them, decided as the web's PR panel does:
 * GitHub's checks, each opening a page of its own (state, summary, annotations, steps and a
 * log read page by page), with its re-runs, cancel and "Fix with agent"; and the project's
 * local check of this head (ADR 0094), started and stopped from the phone. A write is sent
 * once; the page reads GitHub again to show what it did.
 */

const project = z.string().min(1).max(512);
const target = {
  project,
  number: z.number().int().positive(),
  repository: ForgeRepository.optional(),
};
const runId = z.number().int().positive();
export const ForgeChecksRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("forge.pull.checks"), ...target }),
  z.object({ type: z.literal("forge.pull.check"), ...target, checkId: z.string().min(1).max(256) }),
  z.object({
    type: z.literal("forge.pull.check.log"),
    project,
    repository: ForgeRepository.optional(),
    checkRunId: runId,
    jobId: runId.optional(),
    /** The run's state as the page read it: a running job's log is read again. */
    finished: z.boolean(),
    from: z.number().int().nonnegative(),
    count: z.number().int().positive().max(2_000),
  }),
  z.object({
    type: z.literal("forge.local.log"),
    runId: z.string().min(1).max(64),
    from: z.number().int().nonnegative(),
    count: z.number().int().positive().max(2_000),
  }),
  z.object({
    type: z.literal("forge.checks.write"),
    project,
    number: z.number().int().positive(),
    repository: ForgeRepository,
    action: ForgeCheckAction,
  }),
  z.object({
    type: z.literal("forge.local.write"),
    project,
    number: z.number().int().positive(),
    repository: ForgeRepository,
    /** Start checks the head shown; stop names the run shown. */
    action: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("start"), headSha: z.string().regex(/^[a-fA-F0-9]{40,64}$/) }),
      z.object({ kind: z.literal("cancel"), runId: z.string().min(1).max(64) }),
    ]),
  }),
]);
export type ForgeChecksRequest = z.infer<typeof ForgeChecksRequest>;

export interface CheckRow {
  id: string;
  name: string;
  word: string;
  tone: string;
  /** GitHub has a run behind it to open; commit statuses only link to their app. */
  opens: boolean;
  url: string | null;
}
export interface LocalCheck {
  name: string;
  word: string;
  tone: string;
  runId: string | null;
  /** The one control, or null where the project has no check command. */
  action: { kind: "start" | "cancel"; label: string; disabled: boolean } | null;
  note: string | null;
}
export interface ChecksReply {
  type: "forge.pull.checks";
  headSha: string;
  checks: CheckRow[];
  local: LocalCheck | null;
  /** GitHub couldn't say how the checks stand; a refresh asks again. */
  stale: boolean;
}

export interface CheckReply {
  type: "forge.pull.check";
  name: string;
  word: string;
  tone: string;
  url: string | null;
  checkRunId: number | null;
  jobId: number | null;
  finished: boolean;
  output: { title: string | null; summary: string | null; text: string | null };
  annotations: {
    where: string | null;
    level: string;
    tone: string;
    title: string | null;
    message: string;
  }[];
  annotationsMore: boolean;
  steps: { name: string; word: string; tone: string; line: number | null }[];
  log: { lines: number; truncated: boolean; focus: number | null; errors: number[] } | null;
  note: string | null;
  workflow: { runId: number; attempt: number } | null;
  controls: { rerunFailed: boolean; rerunAll: boolean; cancel: boolean; fix: boolean };
  /** What "Fix with agent" asks, and the thread it goes to (null starts a new one). */
  fix: {
    request: string;
    threadId: string | null;
    /** With no linked thread, the pull request a new thread starts on, at the head shown. */
    pullRequest: {
      repository: ForgeRepository;
      number: number;
      headSha: string;
      title: string;
    };
  } | null;
}

export interface ChecksWriteReply {
  type: "forge.write";
  ok: boolean;
  message: string;
  uncertain: boolean;
}

const stepLook: Record<ForgeCheckStep["status"], { word: string; tone: string }> = {
  success: { word: "Passed", tone: "done" },
  failure: { word: "Failed", tone: "failed" },
  pending: { word: "Running", tone: "working" },
  cancelled: { word: "Cancelled", tone: "idle" },
  skipped: { word: "Skipped", tone: "idle" },
  unknown: { word: "Unknown", tone: "idle" },
};
const levelLook = {
  failure: { word: "Error", tone: "failed" },
  warning: { word: "Warning", tone: "needs-you" },
  notice: { word: "Notice", tone: "idle" },
} as const;

const open = (detail: ForgePrDetail) =>
  detail.status.state === "open" || detail.status.state === "draft";

function verify(owner: ForgeOwner, op: VerifyOperation): Promise<VerifyResult> {
  return owner.request({ type: "verify.request", op }, { timeoutMs: 15_000 });
}

async function localCheck(
  owner: ForgeOwner,
  request: { project: string },
  detail: ForgePrDetail,
  preview: Preview,
): Promise<LocalCheck | null> {
  const listed = await verify(owner, {
    action: "list",
    workspaceId: WorkspaceId.parse(request.project),
  }).catch(() => undefined);
  if (!listed?.ok) return null;
  const { ref, headSha } = detail.status;
  const pr = { owner: ref.repository.owner, name: ref.repository.name, number: ref.number };
  const run = latestLocalCheck(listed.runs ?? [], pr, headSha);
  const command = listed.command ?? null;
  // Open PRs always show their local check; finished ones only one that ran.
  if (!run && !open(detail)) return null;
  const look = localCheckLook(run);
  if (command === null && !run)
    return {
      name: "Local",
      word: look.word,
      tone: look.tone,
      runId: null,
      action: null,
      note: "This project has no check command. Set one in the project's settings on your computer.",
    };
  return {
    name: preview(`Local · ${run?.command ?? command ?? ""}`, 300),
    word: look.word,
    tone: look.tone,
    runId: run?.id ?? null,
    action: localCheckAction(run),
    note: null,
  };
}

export async function readChecks(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeChecksRequest, { type: "forge.pull.checks" }>,
  preview: Preview,
): Promise<ChecksReply> {
  const detail = await prDetail(reads, request);
  return {
    type: "forge.pull.checks",
    headSha: detail.status.headSha,
    checks: detail.status.checks.slice(0, 200).map((check) => ({
      id: check.id,
      name: preview(check.name, 200),
      word: checkLook[check.status].word,
      tone: checkLook[check.status].tone,
      opens: checkRunId(check) !== undefined,
      url: check.url,
    })),
    local: await localCheck(owner, request, detail, preview),
    stale: detail.status.ci === "unknown",
  };
}

async function checkRun(
  reads: ForgeReads,
  scope: { project: string; repository?: ForgeRepository | undefined },
  id: number,
  jobId: number | undefined,
  finished: boolean,
): Promise<ForgeCheckRun> {
  const value = await reads.read(
    {
      op: "forge.pr.check",
      workspaceId: scope.project,
      ...(scope.repository ? { repository: scope.repository } : {}),
      checkRunId: id,
      ...(jobId ? { jobId } : {}),
    },
    // A finished run never changes; a running one is read again every time.
    finished,
  );
  if (value.resource !== "prCheck") throw new ForgeRefusal("forge_invalid_data");
  return value.value;
}

/** Where an annotation points, when it names a file. */
const where = (path: string, line: number | null) =>
  fileAnnotation(path) ? `${path}${line ? `:${line}` : ""}` : null;

export async function readCheck(
  reads: ForgeReads,
  logs: LogPages,
  request: Extract<ForgeChecksRequest, { type: "forge.pull.check" }>,
  preview: Preview,
): Promise<CheckReply> {
  const detail = await prDetail(reads, request);
  const check = detail.status.checks.find((each) => each.id === request.checkId);
  if (!check) throw new ForgeRefusal("forge_not_found");
  const id = checkRunId(check);
  const finished = check.status !== "pending";
  const run =
    id === undefined
      ? undefined
      : await checkRun(reads, request, id, check.jobId ?? undefined, finished);
  if (run?.log) logs.keep(run.id, run.log.text);
  const linked = detail.relatedThreads.find((thread) => !thread.archived);
  const controls = checkControls(check, run, open(detail));
  return {
    type: "forge.pull.check",
    name: preview(check.name, 200),
    ...checkLook[check.status],
    url: check.url,
    checkRunId: id ?? null,
    jobId: check.jobId ?? null,
    finished,
    output: run
      ? {
          title: run.output.title && preview(run.output.title, 400),
          summary: run.output.summary && preview(run.output.summary, 8_000),
          text: run.output.text && preview(run.output.text, 8_000),
        }
      : { title: null, summary: null, text: null },
    annotations: (run?.annotations ?? []).map((annotation) => ({
      where: where(annotation.path, annotation.startLine),
      level: levelLook[annotation.level].word,
      tone: levelLook[annotation.level].tone,
      title: annotation.title ? preview(annotation.title, 400) : null,
      message: preview(annotation.message, 4_000),
    })),
    annotationsMore: run?.annotationsTruncated ?? false,
    steps: (run?.workflow?.steps ?? [])
      .filter((step) => step.status !== "skipped")
      .map((step) => ({
        name: preview(step.name, 300),
        word: stepLook[step.status].word,
        tone: stepLook[step.status].tone,
        line: step.line,
      })),
    log: run?.log
      ? {
          lines: logs.count(run.id),
          truncated: run.log.truncated,
          focus: run.log.focus,
          errors: run.log.errors,
        }
      : null,
    note: run ? (checkLogNote(check, run) ?? null) : "GitHub reports nothing more for this check.",
    workflow: run?.workflow ? { runId: run.workflow.runId, attempt: run.workflow.attempt } : null,
    controls,
    fix: controls.fix
      ? {
          request: checkFixRequest(
            { name: check.name, url: check.url },
            { number: detail.status.ref.number, url: detail.status.url },
            run,
          ),
          threadId: linked?.id ?? null,
          pullRequest: {
            repository: detail.status.ref.repository,
            number: detail.status.ref.number,
            headSha: detail.status.headSha,
            title: preview(detail.status.title, 512),
          },
        }
      : null,
  };
}

export async function readCheckLog(
  reads: ForgeReads,
  logs: LogPages,
  request: Extract<ForgeChecksRequest, { type: "forge.pull.check.log" }>,
): Promise<LogPage> {
  if (!request.finished || !logs.has(request.checkRunId)) {
    const run = await checkRun(reads, request, request.checkRunId, request.jobId, request.finished);
    logs.keep(run.id, run.log?.text ?? "");
  }
  return logs.page(request.checkRunId, request.from, request.count);
}

export async function readLocalLog(
  owner: ForgeOwner,
  logs: LogPages,
  request: Extract<ForgeChecksRequest, { type: "forge.local.log" }>,
): Promise<LogPage> {
  const reply = await verify(owner, { action: "log", runId: request.runId });
  if (!reply.ok) throw new ForgeRefusal(reply.error ?? "unavailable");
  const key = `local:${request.runId}`;
  logs.keep(key, reply.log?.text ?? "");
  return logs.page(key, request.from, request.count);
}

const write = (ok: boolean, message: string, uncertain = false): ChecksWriteReply => ({
  type: "forge.write",
  ok,
  message,
  uncertain,
});

export async function writeChecks(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeChecksRequest, { type: "forge.checks.write" }>,
): Promise<ChecksWriteReply> {
  const command = ForgeHostedChecksCommand.parse({
    type: "forge.hosted.checks",
    workspaceId: request.project,
    pr: { repository: request.repository, number: request.number },
    action: request.action,
  });
  const cancel = request.action.kind === "cancel";
  try {
    const result = await owner.command(command);
    reads.forget(request.project);
    if (result.ok) return write(true, cancel ? "Cancel sent to GitHub" : "Re-run sent to GitHub");
    const uncertain = outcomeUncertain(result.error);
    return write(false, actionErrorText(result.error), uncertain);
  } catch (error) {
    reads.forget(request.project);
    const code =
      error instanceof ClientError || error instanceof ForgeRefusal ? error.code : undefined;
    return write(
      false,
      actionErrorText(code ?? "action_outcome_uncertain"),
      outcomeUncertain(code),
    );
  }
}

const refusals: Partial<Record<NonNullable<VerifyResult["error"]>, string>> = {
  no_command:
    "This project has no check command. Set one in the project's settings on your computer.",
  busy: "Too many runs are waiting in this project. Try again once one finishes.",
  settled: "That check already finished.",
  forbidden: "View only. Pair this phone with View and act to run checks.",
};

export async function writeLocal(
  owner: ForgeOwner,
  reads: ForgeReads,
  request: Extract<ForgeChecksRequest, { type: "forge.local.write" }>,
): Promise<ChecksWriteReply> {
  const action = request.action;
  let op: VerifyOperation;
  if (action.kind === "cancel") op = { action: "cancel", runId: action.runId };
  else {
    const detail = await prDetail(reads, request);
    op = {
      action: "start",
      workspaceId: WorkspaceId.parse(request.project),
      target: {
        kind: "check",
        pr: {
          pr: { repository: request.repository, number: request.number },
          headSha: action.headSha,
          title: detail.status.title.slice(0, 512),
        },
      },
    };
  }
  try {
    const reply = await verify(owner, op);
    if (reply.ok)
      return write(true, action.kind === "start" ? "Local check started" : "Local check stopped");
    return write(
      false,
      (reply.error && refusals[reply.error]) ?? "Verify didn't answer. Try again.",
    );
  } catch {
    return write(false, "Verify didn't answer. Try again.");
  }
}
