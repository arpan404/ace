import type {
  MarketEntryDetail,
  MarketNeed,
  MarketReview,
  MarketScanReport,
} from "@ace/protocol/marketplace";
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
export type MarketStep =
  | "read"
  | "review"
  | "install"
  | "remove"
  | "add"
  | "removeSource"
  | "publish"
  | "change";

const stepFailed: Readonly<Record<MarketStep, string>> = {
  read: "The marketplace couldn't be read.",
  review: "This entry couldn't be reviewed.",
  install: "The install didn't finish, and nothing was installed.",
  remove: "It couldn't be removed.",
  add: "That catalog couldn't be added.",
  removeSource: "That catalog couldn't be removed.",
  publish: "It couldn't be published. Try again.",
  change: "The change didn't go through. Try again.",
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
    case "signed_out":
      return "Sign in to publish.";
    case "reauth":
      return "Sign in again to do this.";
    case "blocked":
      return step === "review"
        ? "ace's scan on this device refused it."
        : "ace's scan refused it. Fix what it found, then try again.";
    case "suspended":
      return "Your publisher account is suspended.";
    case "quota":
      return "You've reached your publishing limit for now.";
    default:
      return stepFailed[step];
  }
}

/** The marketplace answered with an error, or with something other than what was asked. */
export class MarketFailure extends Error {
  readonly code: string;
  /** The scan that refused it, when a scan did (`blocked`). */
  readonly scan: MarketScanReport | undefined;
  /** The daemon's own words for why, when it gave them. */
  readonly detail: string | undefined;
  constructor(code: string, scan?: MarketScanReport, detail?: string) {
    super(`marketplace: ${code}`);
    this.code = code;
    this.scan = scan;
    this.detail = detail;
  }
}

/** A scan's findings as the sentences the person reads, blocks first. */
export function findingSentences(scan: MarketScanReport | undefined): string[] {
  if (!scan) return [];
  const order = { block: 0, warn: 1, note: 2 } as const;
  return scan.findings
    .toSorted((a, b) => order[a.level] - order[b.level])
    .map((finding) => sentence(finding.message));
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

/**
 * What a flagged file in a review is, in a word: the market flags every executable and every file
 * that isn't a text format, and a font or a picture is no program. Undefined when unflagged.
 */
export function flaggedWord(file: {
  path: string;
  executable: boolean;
  flagged: boolean;
}): string | undefined {
  if (file.executable) return "A script or program";
  if (!file.flagged) return undefined;
  const extension = file.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (["woff2", "woff", "ttf", "otf"].includes(extension)) return "Font";
  if (["webp", "png", "jpg", "jpeg", "gif", "avif"].includes(extension)) return "Picture";
  if (["mp4", "m4v", "mov", "webm"].includes(extension)) return "Video";
  if (["js", "mjs", "cjs", "ts", "py", "sh", "rb", "wasm"].includes(extension)) return "Code";
  return "Not text";
}

/** "1 file", "12 files". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "A", "A and B", "A, B and C". */
export function andList(words: readonly string[]): string {
  if (words.length < 2) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What one review's body lets the entry do, as plain sentences. */
export function canDoSentences(review: MarketReview): string[] {
  const body = review.body;
  switch (body.type) {
    case "suit": {
      // A daemon from before families were tidied at the source sends repeats; each shows once.
      const fonts = [...new Set(body.fonts)];
      return [
        body.passes
          ? "Passes ace's checks."
          : `Fails ace's checks in ${count(body.problems.length, "place")}.`,
        body.scenes.length
          ? "Runs its own animation, sandboxed."
          : "Changes how ace looks, nothing else.",
        ...(fonts.length ? [`Sets its fonts: ${andList(fonts)}.`] : []),
        `${count(body.files, "file")}.`,
      ];
    }
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
