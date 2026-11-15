import type { ApprovalTarget } from "@ace/protocol";
import type { ApprovalCopy } from "./approval-copy.ts";
import type { LostChildAsk } from "./lost-child.ts";
import { pluralCount } from "./counts.ts";
import type { RowStatusIconKind, RowStatusTone } from "./row-status-display.ts";
import { waitWords } from "./wait-words.ts";

/*
 * The strips that dock above the phone's composer, as one family: one short sentence that leads
 * with the provider's mark (an agent asks) or a status icon (something holds the thread), then
 * at most one line under it: the payload in mono (a command, a path) or a muted detail (the
 * question asked). The full content (a plan, a question's options, an approval's reasons) opens
 * in a sheet. The icons and their colours are the thread row's (`rowStatusLook`). Pure.
 */

/** What leads the sentence: the asking agent's provider mark, or a status icon in its colour. */
export type StripLead = { provider: string } | { icon: RowStatusIconKind; tone: RowStatusTone };

export interface StripLine {
  lead: StripLead;
  sentence: string;
  /** One mono line under the sentence: a command or a path; empty when there is none. */
  payload: string;
  /** One muted line under the sentence in prose (the question asked); empty when none. */
  detail: string;
}

const line = (lead: StripLead, sentence: string, more: Partial<StripLine> = {}): StripLine => ({
  lead,
  sentence,
  payload: more.payload ?? "",
  detail: more.detail ?? "",
});

const firstLine = (text: string) =>
  text
    .split("\n")
    .find((part) => part.trim())
    ?.trim() ?? "";

/**
 * An approval as one sentence: "Claude wants to run a command" with the command under it,
 * "… wants to edit 2 files" with the first path, "… wants to upload a file", "… wants to run
 * code on the page"; anything else says it wants approval, with the request's own title.
 */
export function approvalStripLine(
  copy: Pick<ApprovalCopy, "command" | "code" | "files" | "title">,
  target: Pick<ApprovalTarget, "paths" | "access"> | undefined,
  who: string,
  provider: string,
): StripLine {
  const lead = { provider };
  if (copy.command)
    return line(lead, `${who} wants to run a command`, { payload: firstLine(copy.command) });
  if (copy.code)
    return line(lead, `${who} wants to run code on the page`, { payload: firstLine(copy.code) });
  if (copy.files.length)
    return line(lead, `${who} wants to upload ${pluralCount(copy.files.length, "file", "files")}`, {
      payload: copy.files[0] ?? "",
    });
  const paths = target?.paths ?? [];
  if (paths.length) {
    const verb = target?.access === "read" ? "read" : target?.access === "execute" ? "run" : "edit";
    return line(lead, `${who} wants to ${verb} ${pluralCount(paths.length, "file", "files")}`, {
      payload: paths[0] ?? "",
    });
  }
  return line(lead, `${who} wants approval`, { detail: copy.title });
}

/**
 * The daemon's request about a lost child (`lostChildAsk`): its own sentence, since no agent
 * asks it, with what else the person can do under it.
 */
export function lostChildStripLine(
  ask: Pick<LostChildAsk, "sentence">,
  detail: string,
  provider: string,
): StripLine {
  return line({ provider }, ask.sentence, { detail });
}

/** "Claude has a question" (or "… 3 questions"), with the first question asked under it. */
export function questionStripLine(
  questions: readonly string[],
  who: string,
  provider: string,
): StripLine {
  const sentence =
    questions.length > 1 ? `${who} has ${questions.length} questions` : `${who} has a question`;
  return line({ provider }, sentence, { detail: questions[0] ?? "" });
}

/** A plan waiting for review: its one line (`planReviewLine`), led by the provider's mark. */
export function planStripLine(sentence: string, provider: string): StripLine {
  return line({ provider }, sentence);
}

/** A form an MCP server asks for, or help in the browser: who asks, then what for. */
export function formStripLine(title: string, who: string, provider: string): StripLine {
  return line({ provider }, `${who} needs a few details`, { detail: title });
}
export function browserHelpStripLine(title: string, who: string, provider: string): StripLine {
  return line({ provider }, `${who} needs your help in the browser`, { detail: title });
}

/**
 * What leads a hold's sentence, by its kind (the queue's notices, `queueHold`): a usage limit
 * the muted gauge, a turn a restart cut short the warning circle, a send that may have gone the
 * needs-you hand, and any other wait (a paused queue, a resume at reset) the countdown clock.
 */
export function holdStripLead(kind: string): StripLead {
  if (kind === "limit") return { icon: "limited", tone: "limited" };
  if (kind === "restart") return { icon: "failed", tone: "failed" };
  if (kind === "uncertain") return { icon: "approve", tone: "needs-you" };
  return { icon: "waiting", tone: "waiting" };
}

/** A message that didn't go: "Not sent · <why>", with its opening words under it. */
export function notSentStripLine(reason: string, text: string): StripLine {
  const why = reason.replace(/^Not sent\s*·?\s*/i, "").trim();
  return line({ icon: "approve", tone: "needs-you" }, why ? `Not sent · ${why}` : "Not sent", {
    detail: firstLine(text),
  });
}

/**
 * Commands a stopped or finished turn left running, with one Stop for all of them: "Running
 * `bun run dev`" (the command as the payload) or "Running 2 commands". Undefined while the turn
 * still works or subagents carry on: the live pill says that.
 */
export function leftRunningStripLine(input: {
  /** The root's turn was stopped, or the thread is done. */
  over: boolean;
  subagents: number;
  commands: readonly string[];
}): StripLine | undefined {
  if (!input.over || input.subagents > 0 || !input.commands.length) return undefined;
  const words = waitWords({
    kind: "background",
    count: input.commands.length,
    title: input.commands.length === 1 ? input.commands[0] : undefined,
    shells: true,
    taskIds: [],
  });
  return line({ icon: "background", tone: "background" }, words.label, {
    payload: words.code ?? "",
  });
}
