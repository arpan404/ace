import { spadeRecord } from "./json.ts";
import { spadeNeedsYouWords } from "./needs-you.ts";
import { spadeRequestAct } from "./request-acts.ts";
import { spadeRequestCard } from "./request-words.ts";

/*
 * Why a bot needs the person, in a few words, from what it actually waits on ("Wants to pay €412
 * to TAP Air Portugal", "Asks: Q2 or Q3 last year?", "Wants you to connect GitHub"). One function,
 * so the list row and the conversation's "needs you" line say the same thing.
 */

/** One approval or question a bot waits on, as Spade's roster sends it (`pending`). */
export type SpadePendingAsk =
  | {
      kind: "approval";
      name: string;
      arguments?: unknown;
      /** What the gate read the call as doing (`pay`, `send_as_person`, `change_access`, ...). */
      effect?: string | undefined;
      reason?: string | undefined;
    }
  | { kind: "question"; prompt: string }
  | { kind: "connect"; app: string };

/** The longest a question is quoted before an ellipsis. */
const QUESTION_CHARS = 60;

const oneLine = (text: string) =>
  text
    .replace(/[`*_~#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

function shorten(text: string, longest: number): string {
  const line = oneLine(text);
  return line.length > longest ? `${line.slice(0, longest - 1).trimEnd()}…` : line;
}

/** `gh pr comment 12 --body x` → `gh pr comment`: the command's words up to its first argument. */
function commandWords(command: string): string {
  const words: string[] = [];
  for (const word of oneLine(command).split(" ")) {
    if (words.length === 3 || /^[-\d"'$./~]/.test(word)) break;
    words.push(word);
  }
  return words.join(" ");
}

/** The email or message's recipient, when the arguments name one. */
function recipient(args: unknown): string | undefined {
  const fields = spadeRecord(args);
  const to = fields?.to ?? fields?.recipient ?? fields?.recipients;
  const first = Array.isArray(to) ? to[0] : to;
  const named = spadeRecord(first);
  const value = typeof first === "string" ? first : (named?.name ?? named?.email);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** What an approval would do, after "Wants to". */
function approvalAct(ask: Extract<SpadePendingAsk, { kind: "approval" }>): string {
  const act = spadeRequestAct(ask.name, ask.arguments, ask.effect);
  if (act) return act;
  const fields = spadeRecord(ask.arguments);
  const command = typeof fields?.command === "string" ? commandWords(fields.command) : "";
  if (ask.name === "shell" && command) return `run ${command}`;
  const to = recipient(ask.arguments);
  if (to && /(^|_)(e?mail|send_email|gmail)/.test(ask.name)) return `email ${to}`;
  const sentence = spadeRequestCard(ask.name, ask.arguments, "It", {
    effect: ask.effect,
  }).sentence;
  return sentence.replace(/^It wants to /, "").replace(/\.$/, "");
}

/** How much it matters that the person sees it first: lower first. */
function rank(ask: SpadePendingAsk): number {
  if (ask.kind === "question") return 5;
  if (ask.kind === "connect") return 3;
  if (
    ask.effect === "pay" ||
    spadeRequestAct(ask.name, ask.arguments, ask.effect)?.startsWith("pay")
  )
    return 0;
  if (ask.effect === "send_as_person") return 1;
  if (ask.effect === "change_access" || ask.effect === "credential") return 2;
  return 4;
}

function words(ask: SpadePendingAsk): string {
  if (ask.kind === "question") return `Asks: ${shorten(ask.prompt, QUESTION_CHARS)}`;
  if (ask.kind === "connect") return `Wants you to connect ${oneLine(ask.app)}`;
  return `Wants to ${approvalAct(ask)}`;
}

/**
 * Why the bot needs the person: the most important of what it waits on (a payment, then sending
 * as them, then access, then other approvals, then questions; the earlier asked first among
 * equals), then "+2 more" for the rest. With nothing pending (a Spade that doesn't send the
 * list, a worker or club that waits) `fallback` is the bot's own few words, else "Needs you".
 */
export function spadeNeedsYouLine(
  pending: readonly SpadePendingAsk[],
  fallback?: string | undefined,
): string {
  const [top, ...others] = pending
    .map((ask, index) => ({ ask, index }))
    .toSorted((a, b) => rank(a.ask) - rank(b.ask) || a.index - b.index);
  if (!top) return spadeNeedsYouWords(fallback);
  return others.length ? `${words(top.ask)} · +${others.length} more` : words(top.ask);
}
