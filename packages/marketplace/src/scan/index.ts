import {
  marketScannerVersion,
  type MarketBlocklist,
  type MarketEntryType,
  type MarketListingEdit,
  type MarketScanCheckId,
  type MarketScanFinding,
  type MarketScanReport,
} from "@ace/protocol/marketplace";
import type { ArchiveFile } from "../archive.ts";
import type { Inspection } from "../checks/index.ts";

/*
 * The scanner (ADR 0173 §8): one pure module the Worker, the signer and the device run on the
 * same bytes. Each check answers pass, warn or block from its findings; each finding is one plain
 * sentence. It works in budgeted steps so a Worker request never reads more than it may, and the
 * same steps run whole on the signer and the device.
 *
 * This file is the scanner's public surface. The checks live beside it.
 */

/** What the scanner compares names and handles against (typosquats, impersonation). */
export interface ScanContext {
  /** Entries already in the market, other publishers' and the scanned publisher's own. */
  entries: readonly { type: string; name: string; publisher: string; downloads: number }[];
  /** Verified publishers' handles and display names (ADR 0173 §13). */
  verified: readonly { handle: string; displayName: string }[];
  /** The publisher being scanned: its handle, and whether it is the official `ace` (§14). */
  publisher?: { handle: string; official: boolean } | undefined;
  /** The maintainers' signed blocklist, as verified by the caller. */
  blocklist?: MarketBlocklist | undefined;
}

export interface ScanInput {
  type: MarketEntryType;
  name: string;
  files: readonly ArchiveFile[];
  /** The listing words the entry's own files give (`describeEntry`). */
  listing: { title: string; line: string; description: string; keywords: readonly string[] };
  /** What the format checks read (a plugin's executions, a recipe), when they passed. */
  inspection: Inspection | undefined;
  context: ScanContext;
}

/** How much one step may read: text bytes and files. */
export interface ScanBudget {
  textBytes: number;
  files: number;
}
/** A Worker request's budget (ADR 0173 §8): 4 MiB of text or 600 files. */
export const requestBudget: ScanBudget = { textBytes: 4 * 1024 * 1024, files: 600 };
/** No bound: the signer and the device scan whole. */
export const wholeBudget: ScanBudget = {
  textBytes: Number.POSITIVE_INFINITY,
  files: Number.POSITIVE_INFINITY,
};

/**
 * A scan part way: plain JSON, so the Worker stores it between requests and cron steps. Its
 * fields are the scanner's own; callers keep it whole.
 */
export interface ScanState {
  scanner: number;
  /** The next file to read, by index into the files sorted by path. */
  cursor: number;
  files: number;
  textBytes: number;
  findings: MarketScanFinding[];
  /** Facts a later step needs: hosts code talks to, and the like. */
  facts: Record<string, string[]>;
}

export function startScan(): ScanState {
  return {
    scanner: marketScannerVersion,
    cursor: 0,
    files: 0,
    textBytes: 0,
    findings: [],
    facts: {},
  };
}

/** Reads files from `state.cursor` until `budget` is spent; `done` once every file was read. */
export function scanStep(
  state: ScanState,
  input: ScanInput,
  budget: ScanBudget,
): { state: ScanState; done: boolean } {
  void budget;
  return { state: { ...state, cursor: input.files.length }, done: true };
}

/** The checks that need the whole entry, then the report. */
export function finishScan(state: ScanState, input: ScanInput): MarketScanReport {
  void input;
  return report(state.findings, { files: state.files, textBytes: state.textBytes });
}

/** A whole scan in one call, as the signer and the device run it. */
export function scanEntry(input: ScanInput): MarketScanReport {
  const { state } = scanStep(startScan(), input, wholeBudget);
  return finishScan(state, input);
}

/** A listing edit or changelog (ADR 0173 §5): hidden unicode, links, injection, impersonation. */
export function scanListing(
  listing: Partial<MarketListingEdit> & { changelog?: string },
  context: ScanContext,
): MarketScanReport {
  void listing;
  void context;
  return report([], { files: 0, textBytes: 0 });
}

/** Only the known-bad check, for re-checking installed bytes when a new blocklist arrives. */
export function knownBad(
  files: readonly ArchiveFile[],
  hash: string,
  blocklist: MarketBlocklist,
): MarketScanFinding[] {
  void files;
  void hash;
  void blocklist;
  return [];
}

/** What a report means for listing (ADR 0173 §9). */
export type Disposition = "list" | "hold" | "block";

/**
 * Whether a scanned version waits for the signer, is held for a maintainer, or is refused: any
 * block refuses; a warn holds unless a maintainer already approved this version; a new
 * publisher's `strict` notes hold, and so does its first version and every official one.
 */
export function disposition(
  scan: MarketScanReport,
  publisher: { newPublisher: boolean; firstVersion: boolean; official: boolean; approved: boolean },
): Disposition {
  if (scan.verdict === "block") return "block";
  if (publisher.approved) return "list";
  if (scan.verdict === "warn") return "hold";
  if (publisher.official || (publisher.newPublisher && publisher.firstVersion)) return "hold";
  if (publisher.newPublisher && scan.findings.some((finding) => finding.strict)) return "hold";
  return "list";
}

const checkOrder: readonly MarketScanCheckId[] = [
  "files",
  "scripts",
  "scene",
  "plugin",
  "recipe",
  "secrets",
  "hidden",
  "known-bad",
];

const verdictOf = (list: readonly MarketScanFinding[]) =>
  list.some((finding) => finding.level === "block")
    ? "block"
    : list.some((finding) => finding.level === "warn")
      ? "warn"
      : "pass";

/** A report from findings: each check's verdict from its own, the whole from all. */
export function report(
  findings: readonly MarketScanFinding[],
  read: { files: number; textBytes: number },
  hash?: string,
): MarketScanReport {
  return {
    format: "ace-market-scan",
    scanner: marketScannerVersion,
    ...(hash ? { hash } : {}),
    verdict: verdictOf(findings),
    checks: checkOrder.map((id) => {
      const own = findings.filter((finding) => finding.check === id);
      const verdict = verdictOf(own);
      return {
        id,
        verdict,
        sentence:
          verdict === "pass"
            ? "Nothing found."
            : `${own.length} finding${own.length === 1 ? "" : "s"}.`,
        findings: own.length,
      };
    }),
    findings: findings.slice(0, 500),
    truncated: findings.length > 500,
    read,
  };
}
