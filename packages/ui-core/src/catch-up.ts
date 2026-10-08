import type { ThreadCatchUpResponse, TurnDigest } from "@ace/protocol";
import { digestFacts, oneLine, toolTotal, type DigestFact } from "./turn-digest.ts";
import { formatCount } from "./counts.ts";

/*
 * "While you were away": the deterministic catch-up digest (ADR 0062) as a card reads it.
 * Built only from the daemon's persisted digest, never from transcript history, and never by
 * asking a provider. Pure.
 */

type CatchUp = Pick<
  ThreadCatchUpResponse,
  "turnsCompleted" | "digest" | "latestAgentMessagePreview" | "status"
>;

/** Whether anything happened worth a card: work done, or something waiting on the person. */
export function catchUpHasNews(catchUp: CatchUp): boolean {
  const digest = catchUp.digest;
  return (
    catchUp.turnsCompleted > 0 ||
    toolTotal(digest) > 0 ||
    digest.files.length > 0 ||
    digest.commandsRun > 0 ||
    digest.approvalsAsked > 0 ||
    digest.approvalsPending > 0 ||
    digest.subagentsStarted > 0 ||
    digest.errors > 0
  );
}

export interface CatchUpFile {
  path: string;
  added: number | null;
  removed: number | null;
}

export interface CatchUpView {
  /** "3 turns finished", "Still on the same turn". */
  headline: string;
  facts: DigestFact[];
  /** The first files changed, in the digest's order. */
  files: CatchUpFile[];
  /** Files changed beyond those listed (including any the digest left out). */
  moreFiles: number;
  /** Commands that failed, newest last, at most `listed`. */
  failedCommands: { itemId: string; command: string; exitCode: number | null | undefined }[];
  /** "Ran 12 commands, 2 failed". */
  commandLine: string | undefined;
  /** "2 of 3 subagents finished". */
  subagentLine: string | undefined;
  /** The newest thing the agent said, on one line. */
  latestMessage: string | undefined;
  pendingApprovals: number;
}

const listed = 4;

function subagentLine(digest: TurnDigest): string | undefined {
  const started = digest.subagentsStarted;
  if (!started) return undefined;
  const finished = Math.min(started, digest.subagentsFinished);
  if (finished === started)
    return started === 1 ? "1 subagent finished" : `${formatCount(started)} subagents finished`;
  return `${formatCount(finished)} of ${formatCount(started)} subagents finished`;
}

function commandLine(digest: TurnDigest): string | undefined {
  const run = digest.commandsRun;
  if (!run) return undefined;
  const ran = `Ran ${formatCount(run)} ${run === 1 ? "command" : "commands"}`;
  return digest.commandsFailed ? `${ran}, ${formatCount(digest.commandsFailed)} failed` : ran;
}

export function catchUpView(catchUp: CatchUp): CatchUpView {
  const { digest, turnsCompleted } = catchUp;
  const headline = turnsCompleted
    ? `${formatCount(turnsCompleted)} ${turnsCompleted === 1 ? "turn" : "turns"} finished`
    : "No turn finished yet";
  const files = digest.files
    .slice(0, listed)
    .map(({ path, added, removed }) => ({ path, added, removed }));
  const knownMore = digest.files.length - files.length;
  return {
    headline,
    facts: digestFacts(digest),
    files,
    moreFiles: Math.max(0, knownMore),
    failedCommands: digest.commands
      .filter((command) => command.failed)
      .slice(-listed)
      .map(({ itemId, command, exitCode }) => ({ itemId, command: oneLine(command), exitCode })),
    commandLine: commandLine(digest),
    subagentLine: subagentLine(digest),
    latestMessage: oneLine(catchUp.latestAgentMessagePreview) || undefined,
    pendingApprovals: digest.approvalsPending,
  };
}

/**
 * The message Summarise sends: an ordinary user message, so the person sees exactly what the
 * agent was asked and it costs one normal turn.
 */
export const catchUpSummaryRequest =
  "Summarise what happened in this thread since I was last here: the turns you finished, what changed, anything that failed and anything still waiting on me.";
