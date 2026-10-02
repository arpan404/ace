import { ForgeCheck, ForgePrStatus, type ForgePrRef } from "@ace/protocol/forge";
import { z } from "zod";
import { GitHubPr, GitHubCheck, GitHubStatus, GitHubComment } from "./github-schemas.ts";
import { ForgeError } from "./errors.ts";
import { redactData } from "./redact.ts";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(redactData(value));
  if (!result.success) throw new ForgeError("invalid_data");
  return result.data;
}
export function mapCheck(input: unknown): ForgeCheck {
  const check = parse(GitHubCheck, input);
  const conclusion = check.conclusion;
  const status =
    check.status !== "completed"
      ? ["queued", "in_progress", "waiting", "pending", "requested"].includes(check.status)
        ? "pending"
        : "unknown"
      : conclusion === "success" || conclusion === "neutral" || conclusion === "skipped"
        ? "success"
        : ["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(
              conclusion ?? "",
            )
          ? "failure"
          : conclusion === "cancelled"
            ? "cancelled"
            : "unknown";
  const url = check.details_url ?? check.html_url ?? null;
  // GitHub Actions job links carry the job identifier; third-party checks do not.
  const match = url
    ? (/\/actions\/runs\/\d+\/job\/(\d+)(?:\?|$)/.exec(url) ?? /\/runs\/(\d+)(?:\?|$)/.exec(url))
    : null;
  const job = Number(match?.[1]);
  return ForgeCheck.parse({
    id: `check:${check.id}`,
    name: check.name,
    status,
    conclusion,
    completedAt: check.completed_at,
    jobId: Number.isSafeInteger(job) && job > 0 ? job : null,
    url,
  });
}
export function mapLegacyStatus(input: unknown): ForgeCheck {
  const value = parse(GitHubStatus, input);
  return ForgeCheck.parse({
    id: `status:${value.id}`,
    name: value.context,
    status:
      value.state === "pending"
        ? "pending"
        : value.state === "success"
          ? "success"
          : ["failure", "error"].includes(value.state)
            ? "failure"
            : "unknown",
    conclusion: value.state,
    completedAt: value.updated_at,
    jobId: null,
    url: value.target_url,
  });
}
export function ciStatus(checks: readonly ForgeCheck[]): ForgePrStatus["ci"] {
  if (!checks.length) return "none";
  if (checks.some((check) => check.status === "failure" || check.status === "cancelled"))
    return "failure";
  if (checks.some((check) => check.status === "pending")) return "pending";
  if (checks.some((check) => check.status === "unknown")) return "unknown";
  return "success";
}
export function mapComment(input: unknown) {
  const value = parse(GitHubComment, input);
  return {
    kind: "inline" as const,
    id: value.id,
    body: value.body,
    author: value.user?.login ?? "ghost",
    file: value.path ?? null,
    line: value.line ?? value.original_line ?? null,
    updatedAt: value.updated_at,
    replyTo: value.in_reply_to_id ?? null,
  };
}
export function mapPr(ref: ForgePrRef, input: unknown, checks: ForgeCheck[]): ForgePrStatus {
  const value = parse(GitHubPr, input);
  return ForgePrStatus.parse({
    ref,
    title: value.title,
    url: value.html_url,
    headSha: value.head.sha,
    state:
      value.merged || value.merged_at
        ? "merged"
        : value.state === "closed"
          ? "closed"
          : value.state === "open"
            ? value.draft
              ? "draft"
              : "open"
            : "unknown",
    mergeability:
      value.mergeable === true
        ? "mergeable"
        : value.mergeable === false
          ? "conflicting"
          : "unknown",
    ci: ciStatus(checks),
    checks,
    comments: [],
    reviewThreads: [],
    raw: value,
  });
}

export function mapIssueComment(input: unknown) {
  return { ...mapComment(input), kind: "issue" as const };
}
