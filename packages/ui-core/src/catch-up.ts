import type { ThreadCatchUpResponse } from "@ace/protocol";
import { formatCount, pluralCount } from "./counts.ts";

/*
 * "Since you last looked": what a thread did while the person was away, from the catch-up
 * digest (ADR 0062), in a few counts. Pure.
 */

export interface CatchUpFact {
  text: string;
  tone?: "failed" | "needs-you";
}

/**
 * The counts worth a catch-up, in reading order: turns finished, files changed, commands that
 * failed, other errors and requests still waiting. Empty when nothing happened, or while the
 * index is still catching up with the thread (its counts would understate it).
 */
export function catchUpFacts(
  catchUp: Pick<ThreadCatchUpResponse, "ready" | "turnsCompleted" | "digest">,
): CatchUpFact[] {
  if (!catchUp.ready) return [];
  const { digest } = catchUp;
  const facts: CatchUpFact[] = [];
  if (catchUp.turnsCompleted)
    facts.push({ text: `${pluralCount(catchUp.turnsCompleted, "turn")} finished` });
  if (digest.files.length) {
    const files =
      digest.truncated && digest.files.length >= 64
        ? "64+ files"
        : pluralCount(digest.files.length, "file");
    facts.push({ text: `${files} changed` });
  }
  if (digest.commandsFailed)
    facts.push({
      text: `${pluralCount(digest.commandsFailed, "command")} failed`,
      tone: "failed",
    });
  const otherErrors = digest.errors - digest.commandsFailed;
  if (otherErrors > 0) facts.push({ text: pluralCount(otherErrors, "error"), tone: "failed" });
  if (digest.approvalsPending)
    facts.push({
      text: `${formatCount(digest.approvalsPending)} waiting on you`,
      tone: "needs-you",
    });
  return facts;
}
