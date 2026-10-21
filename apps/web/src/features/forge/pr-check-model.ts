import type { ForgeCheck, ForgeCheckRun } from "@ace/protocol";

/*
 * What the PR panel shows for one check, worked out without rendering: which run it reads,
 * where a search lands in its log, and the log excerpt "Fix with agent" hands over. Pure.
 */

/** The check run behind a check (`check:<id>`); commit statuses have none. */
export function checkRunId(check: Pick<ForgeCheck, "id">): number | undefined {
  const match = /^check:(\d+)$/.exec(check.id);
  const id = Number(match?.[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** At most this many matches are found; a search past it narrows instead. */
export const maxMatches = 5_000;

/** The lines containing `query`, ignoring case, in order. */
export function searchLog(lines: readonly string[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: number[] = [];
  for (let index = 0; index < lines.length && matches.length < maxMatches; index++)
    if (lines[index]?.toLowerCase().includes(needle)) matches.push(index);
  return matches;
}

/** The match at or after `from`, wrapping to the first. */
export function nextMatch(matches: readonly number[], from: number): number {
  const index = matches.findIndex((line) => line >= from);
  return index < 0 ? 0 : index;
}

/** Annotations that point at a file: runner-level ones name `.github`, not a file. */
export function fileAnnotation(path: string): boolean {
  return path !== ".github" && path.length > 0;
}

const excerptLines = 60;
const excerptChars = 6_000;

/**
 * The part of the log an agent needs: the failing step up to just past its last error, at
 * most 60 lines and 6,000 characters, newest kept. Empty when there is no log.
 */
export function logExcerpt(run: Pick<ForgeCheckRun, "log" | "workflow">): string {
  const log = run.log;
  if (!log) return "";
  const lines = log.text.split("\n");
  const steps = run.workflow?.steps ?? [];
  const failing = steps.find((step) => step.status === "failure" && step.line !== null);
  const start = failing?.line ?? 0;
  const after = steps
    .map((step) => step.line)
    .filter((line): line is number => line !== null && line > start)
    .toSorted((a, b) => a - b)[0];
  const stop = after ?? lines.length;
  const errors = log.errors.filter((line) => line >= start && line < stop);
  const last = errors.at(-1);
  const end = Math.min(stop, last === undefined ? stop : last + 4);
  let text = lines.slice(Math.max(start, end - excerptLines), end).join("\n");
  if (text.length > excerptChars) text = text.slice(text.length - excerptChars);
  return text;
}

/** What "Fix with agent" asks about a failing check, with what the panel read of it. */
export function checkFixRequest(
  check: { name: string; url: string | null },
  pr: { number: number; url: string },
  run: ForgeCheckRun | undefined,
): string {
  const head = `The check "${check.name}" fails on PR #${pr.number} (${check.url ?? pr.url}).`;
  if (!run) return `${head} Read its log, find the cause and push a fix to the PR branch.`;
  const parts = [head];
  const findings = run.annotations
    .filter((annotation) => annotation.level !== "notice")
    .slice(0, 20)
    .map((annotation) => {
      const where = fileAnnotation(annotation.path)
        ? `${annotation.path}${annotation.startLine ? `:${annotation.startLine}` : ""}: `
        : "";
      return `- ${where}${annotation.message.split("\n")[0] ?? ""}`;
    });
  if (findings.length) parts.push(`Annotations:\n${findings.join("\n")}`);
  const failing = run.workflow?.steps.find((step) => step.status === "failure");
  const excerpt = logExcerpt(run);
  if (excerpt)
    parts.push(
      `Log${failing ? ` of the step "${failing.name}"` : ""}:\n\`\`\`\`text\n${excerpt}\n\`\`\`\``,
    );
  else if (run.output.summary) parts.push(`Summary:\n${run.output.summary.slice(0, 4_000)}`);
  parts.push("Find the cause and push a fix to the PR branch.");
  return parts.join("\n\n");
}
