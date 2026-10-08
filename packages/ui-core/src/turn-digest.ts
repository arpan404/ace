import type { TurnDigest, TurnSummary } from "@ace/protocol";
import { formatSpan } from "./time.ts";
import { formatCount, pluralCount } from "./counts.ts";

/*
 * How a turn's digest (ADR 0062) reads in one line: the timeline, collapsed turns and the
 * catch-up card all say "14 tools · 3 files +12 −4 · 1 failed" the same way. Pure.
 */

export type DigestFactKind =
  | "tools"
  | "files"
  | "lines"
  | "failed"
  | "approvals"
  | "waiting"
  | "subagents"
  | "errors";

/** One fact of a digest. `tone` marks the facts the design colours (failures, waiting on you). */
export interface DigestFact {
  kind: DigestFactKind;
  text: string;
  tone?: "failed" | "needs-you";
  /** Lines added and removed, for the diff colours (only on `lines`). */
  added?: number;
  removed?: number;
}

/** Every tool call of the turn, of any kind. */
export function toolTotal(digest: TurnDigest): number {
  let total = 0;
  for (const count of Object.values(digest.toolCounts)) total += count ?? 0;
  return total;
}

/**
 * Lines added and removed across the digest's files, or undefined when any file's count is
 * unknown (a provider that reports only new contents): a partial sum would understate it.
 */
export function digestLines(digest: TurnDigest): { added: number; removed: number } | undefined {
  let added = 0;
  let removed = 0;
  for (const file of digest.files) {
    if (file.added === null || file.removed === null) return undefined;
    added += file.added;
    removed += file.removed;
  }
  return digest.files.length ? { added, removed } : undefined;
}

/** The digest's facts in reading order, leaving out what didn't happen. */
export function digestFacts(digest: TurnDigest): DigestFact[] {
  const facts: DigestFact[] = [];
  const tools = toolTotal(digest);
  if (tools) facts.push({ kind: "tools", text: pluralCount(tools, "step") });
  if (digest.files.length) {
    // A digest lists at most 64 files and says when it left some out.
    const files = digest.truncated && digest.files.length >= 64 ? "64+ files" : null;
    facts.push({ kind: "files", text: files ?? pluralCount(digest.files.length, "file") });
    const lines = digestLines(digest);
    if (lines)
      facts.push({
        kind: "lines",
        text: `+${formatCount(lines.added)} −${formatCount(lines.removed)}`,
        ...lines,
      });
  }
  if (digest.commandsFailed)
    facts.push({
      kind: "failed",
      text: `${formatCount(digest.commandsFailed)} failed`,
      tone: "failed",
    });
  if (digest.approvalsAsked)
    facts.push({ kind: "approvals", text: pluralCount(digest.approvalsAsked, "approval") });
  if (digest.approvalsPending)
    facts.push({
      kind: "waiting",
      text: `${formatCount(digest.approvalsPending)} waiting on you`,
      tone: "needs-you",
    });
  if (digest.subagentsStarted)
    facts.push({ kind: "subagents", text: pluralCount(digest.subagentsStarted, "subagent") });
  // A failed command is counted as an error too; say only the errors beyond those.
  const otherErrors = digest.errors - digest.commandsFailed;
  if (otherErrors > 0)
    facts.push({ kind: "errors", text: pluralCount(otherErrors, "error"), tone: "failed" });
  return facts;
}

/** How long the turn ran, or has been running ("4m", "1h 12m"); empty under a second. */
export function turnSpan(turn: Pick<TurnSummary, "startedAt" | "endedAt">, now: number): string {
  const end = turn.endedAt ?? Math.max(turn.startedAt, now);
  return end - turn.startedAt < 1000 ? "" : formatSpan(turn.startedAt, end);
}

/** The turn's outcome as a word, for the timeline's accessible names and rows. */
export function turnOutcomeLabel(outcome: TurnSummary["outcome"]): string {
  switch (outcome) {
    case "active":
      return "Running";
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
  }
}

/** One line for the turn's ask: the message that started it, or what kind of turn it was. */
export function turnHeadline(
  turn: Pick<TurnSummary, "initiatingMessagePreview" | "latestAgentMessagePreview">,
): string {
  const ask = oneLine(turn.initiatingMessagePreview);
  if (ask) return ask;
  const answer = oneLine(turn.latestAgentMessagePreview);
  return answer ? answer : "Automatic turn";
}

/** The text as a sentence for an accessible name: ends with one full stop. */
export function asSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/** Collapse whitespace so a preview fits one row. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
