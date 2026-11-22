import type { MarketScanFinding, MarketScanReport } from "@ace/protocol/marketplace";
import { MarketErrorCode } from "@ace/protocol/marketplace";
import { sentence } from "./words.ts";

/* A market failure as one plain sentence, and a scan's findings as the sentences it reads. */

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
  read: "The Store couldn't be read.",
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
      return "The Store can't be reached right now.";
    case "not_found":
      return step === "remove" ? "It isn't installed anymore." : "This entry isn't listed anymore.";
    case "invalid":
      return step === "add" ? "That isn't a git catalog's https address." : stepFailed[step];
    case "refused":
      return step === "review"
        ? "ace refused this entry: it didn't pass ace's checks."
        : stepFailed[step];
    case "forbidden":
      return "This device can't make changes to the Store.";
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

const levelWords = { block: "Blocks it", warn: "Warning", note: "Note" } as const;

/** One finding of a scan as the person reads it: its level, in a word, and its sentence. */
export interface FindingRow {
  level: MarketScanFinding["level"];
  levelWord: string;
  sentence: string;
}

/** A scan's findings with their levels, blocks first, then warnings, then notes. */
export function findingRows(scan: MarketScanReport | undefined): FindingRow[] {
  if (!scan) return [];
  const order = { block: 0, warn: 1, note: 2 } as const;
  return scan.findings
    .toSorted((a, b) => order[a.level] - order[b.level])
    .map((finding) => ({
      level: finding.level,
      levelWord: levelWords[finding.level],
      sentence: sentence(finding.message),
    }));
}

/** A scan's findings as the sentences the person reads, blocks first. */
export function findingSentences(scan: MarketScanReport | undefined): string[] {
  return findingRows(scan).map((row) => row.sentence);
}
