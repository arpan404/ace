import type { MarketEntryDetail, MarketNeed, MarketReview } from "@ace/protocol/marketplace";
import { MarketErrorCode } from "@ace/protocol/marketplace";

/*
 * The marketplace's words and choices (ADR 0168 §12), pure: how a type is named, what keeps an
 * entry from installing, a failure as one plain sentence, and the switches a recipe's review
 * starts with.
 */

const typeWords: Readonly<Record<string, string>> = {
  suit: "Suit",
  "spade-skill": "Skill",
  "spade-plugin": "Plugin",
  "spade-bot": "Bot",
  "ace-plugin": "ace plugin",
};

/** "Suit", "Skill", "Plugin", "Bot"; an unknown type's own name. */
export const typeWord = (type: string): string => typeWords[type] ?? type;

/** Why an entry can't be installed now, in one sentence; undefined when it can. */
export function installBlock(entry: MarketEntryDetail): string | undefined {
  if (!entry.summary.supported) return "Needs a newer ace.";
  const latest = entry.versions[0];
  if (latest?.withdrawn) return `Withdrawn by its publisher: ${sentence(latest.withdrawn)}`;
  return undefined;
}

/** The action at an entry's title row: what pressing it does, or that there is nothing to do. */
export function entryAction(entry: MarketEntryDetail): "install" | "update" | "installed" | "none" {
  if (installBlock(entry) && !entry.installed) return "none";
  if (!entry.installed) return "install";
  return entry.installed.update ? "update" : "installed";
}

const sentence = (text: string) => {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** What was being done when something failed, so its sentence can say so. */
export type MarketStep = "read" | "review" | "install" | "remove" | "add" | "removeSource";

const stepFailed: Readonly<Record<MarketStep, string>> = {
  read: "The marketplace couldn't be read.",
  review: "This entry couldn't be reviewed.",
  install: "The install didn't finish, and nothing was installed.",
  remove: "It couldn't be removed.",
  add: "That catalog couldn't be added.",
  removeSource: "That catalog couldn't be removed.",
};

/**
 * A failure as one plain sentence: never the daemon's raw message, only what its code means for
 * what the person was doing.
 */
export function failureSentence(error: unknown, step: MarketStep): string {
  const parsed = MarketErrorCode.safeParse(error instanceof MarketFailure ? error.code : undefined);
  switch (parsed.success ? parsed.data : undefined) {
    case "unavailable":
      return "The marketplace can't be reached right now.";
    case "not_found":
      return step === "remove" ? "It isn't installed anymore." : "This entry isn't listed anymore.";
    case "invalid":
      return step === "add" ? "That isn't a git catalog's https address." : stepFailed[step];
    case "refused":
      return step === "review"
        ? "ace refused this entry: it didn't pass ace's checks."
        : stepFailed[step];
    case "forbidden":
      return "This device can't make changes to the marketplace.";
    case "conflict":
      return "The entry changed since its review. Review it again.";
    case "expired":
      return "This review expired. Review it again.";
    case "busy":
      return "Another install is running. Try again in a moment.";
    default:
      return stepFailed[step];
  }
}

/** The marketplace answered with an error, or with something other than what was asked. */
export class MarketFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`marketplace: ${code}`);
    this.code = code;
  }
}

/** A recipe's need switches as its review opens them: required ones on, optional ones off. */
export function needDefaults(needs: readonly MarketNeed[]): Record<string, boolean> {
  return Object.fromEntries(needs.map((need) => [need.key, need.required]));
}

/** "3:04 PM", or "Nov 14, 3:04 PM" on another day: when the listings were last read. */
export function readAtText(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  if (new Date(at).toDateString() === new Date(now).toDateString()) return time;
  const day = new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${day}, ${time}`;
}

/** "Nov 14, 2026": the day a version was published. */
export const dateText = (at: number): string =>
  new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** A size in words: "812 bytes", "4.2 KB", "1.3 MB". */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "1 file", "12 files". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What one review's body lets the entry do, as plain sentences. */
export function canDoSentences(review: MarketReview): string[] {
  const body = review.body;
  switch (body.type) {
    case "suit":
      return [
        body.passes
          ? "Passes ace's checks."
          : `Fails ace's checks in ${count(body.problems.length, "place")}.`,
        body.scenes.length
          ? "Runs its own animation, sandboxed."
          : "Changes how ace looks, nothing else.",
        ...(body.fonts.length ? [`Brings its own fonts: ${body.fonts.join(", ")}.`] : []),
        `${count(body.files, "file")}.`,
      ];
    case "spade-skill":
      return [
        `Teaches Spade's bots “${body.skillName}”${body.description ? `: ${sentence(body.description)}` : "."}`,
        body.flagged
          ? `${count(body.files, "file")}, ${body.flagged} of them scripts or programs a bot can run under its gate.`
          : `${count(body.files, "file")}, none of them scripts.`,
      ];
    case "spade-plugin":
      return [
        body.executions
          ? `Runs ${count(body.executions, "command")} on this machine once accepted.`
          : "Runs no commands of its own.",
        ...(body.unsupported ? [`${count(body.unsupported, "part")} this ace can't use yet.`] : []),
        "Your coding agents get it too, unless you turn them off in its settings.",
      ];
    case "spade-bot":
      return [
        `Makes a new bot, ${body.botName}, on your ${body.model} model.`,
        body.routines.length
          ? `Has ${count(body.routines.length, "routine")}, paused until you start them.`
          : "Has no routines.",
        ...(body.tools ? [`Uses only these tools: ${body.tools.join(", ")}.`] : []),
      ];
  }
}
