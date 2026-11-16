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
import { contentHash, hashFiles } from "../hash.ts";
import { text as decodeText } from "../listing.ts";
import { secretFileProblem, secretValueProblems } from "../secrets.ts";
import { filesCheck } from "./checks-files.ts";
import { hiddenEntryFindings, hiddenFileFindings } from "./checks-hidden.ts";
import { knownBadFindings } from "./checks-knownbad.ts";
import { sceneCheck } from "./checks-scene.ts";
import { pluginRules } from "./rules-plugin.ts";
import { recipeRules } from "./rules-recipe.ts";
import { scriptRules } from "./rules-scripts.ts";
import type { EntryRule, ScanFacts } from "./rule.ts";
import { commandViews, fileScriptView, hostsIn, type ScriptView } from "./script-view.ts";
import { hasBidi, hasInvisible, mixedScriptWord } from "./text.ts";
import { linkProblem, readsAsAce, skeleton } from "../profile.ts";
import type { MarketLink } from "@ace/protocol/marketplace";

/** The most text read from one file (ADR 0173 §8): past it a script is a `warn`, not read whole. */
const MAX_FILE_BYTES = 1024 * 1024;

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

/** The entry's files in a stable order, so a step's cursor means the same across requests. */
const sortedFiles = (input: ScanInput): readonly ArchiveFile[] =>
  input.files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const mkFinding = (
  check: MarketScanFinding["check"],
  rule: string,
  level: MarketScanFinding["level"],
  message: string,
  path?: string,
  line?: number,
  strict?: boolean,
): MarketScanFinding => ({
  check,
  rule,
  level,
  ...(path ? { path } : {}),
  ...(line ? { line } : {}),
  message,
  ...(strict ? { strict: true } : {}),
});

/** The one-file-at-a-time work: secrets, hidden characters, hosts, and the script rules. */
function scanFile(input: ScanInput, file: ArchiveFile, state: ScanState): number {
  const named = secretFileProblem(file.path);
  if (named)
    state.findings.push(mkFinding("secrets", "secret-file", "block", named.message, file.path));

  const source = decodeText(file.content);
  if (source === undefined) return 0; // Binary: the `files` check reads its first bytes instead.

  const tooLong = file.content.byteLength > MAX_FILE_BYTES;
  const text = tooLong ? source.slice(0, MAX_FILE_BYTES) : source;
  if (tooLong)
    state.findings.push(
      mkFinding(
        "scripts",
        "too-long",
        "warn",
        `${file.path} is too long to read fully`,
        file.path,
        undefined,
        true,
      ),
    );

  for (const problem of secretValueProblems(text, file.path))
    state.findings.push(
      mkFinding("secrets", "secret-value", "block", problem.message, file.path, problem.line),
    );

  state.findings.push(...hiddenFileFindings(file.path, text));

  const hosts = (state.facts["hosts"] ??= []);
  for (const host of hostsIn(text)) if (!hosts.includes(host)) hosts.push(host);

  const view = fileScriptView(input.type, file.path, text);
  if (view) runScriptRules(view, state);
  return text.length;
}

/** The `scripts`-check rules over one view, each hit a finding. */
function runScriptRules(view: ScriptView, state: ScanState): void {
  if (view.unreadable)
    state.findings.push(
      mkFinding(
        "scripts",
        "unreadable",
        "warn",
        `${view.path} has a command the scanner can't read for sure`,
        view.path,
        undefined,
        true,
      ),
    );
  for (const rule of scriptRules)
    for (const hit of rule.find(view))
      state.findings.push(
        mkFinding("scripts", rule.id, rule.level, hit.message, view.path, hit.line, rule.strict),
      );
}

/** Reads files from `state.cursor` until `budget` is spent; `done` once every file was read. */
export function scanStep(
  state: ScanState,
  input: ScanInput,
  budget: ScanBudget,
): { state: ScanState; done: boolean } {
  const files = sortedFiles(input);
  const next: ScanState = {
    ...state,
    findings: [...state.findings],
    facts: structuredClone(state.facts),
  };
  let readFiles = 0;
  let readBytes = 0;
  while (next.cursor < files.length && readFiles < budget.files && readBytes < budget.textBytes) {
    const file = files[next.cursor];
    if (file) {
      readBytes += scanFile(input, file, next);
      readFiles++;
    }
    next.cursor++;
  }
  next.files = next.cursor;
  next.textBytes = state.textBytes + readBytes;
  return { state: next, done: next.cursor >= files.length };
}

/** The checks that need the whole entry, then the report. */
export function finishScan(state: ScanState, input: ScanInput): MarketScanReport {
  const findings = [...state.findings];
  const facts: ScanFacts = { hosts: [...(state.facts["hosts"] ?? [])] };

  // Non-file script views (a plugin's hooks and servers): their rules and their hosts.
  for (const view of commandViews(input)) {
    const hostState: ScanState = { ...state, findings, facts: { hosts: facts.hosts } };
    runScriptRules(view, hostState);
    for (const host of hostsIn(view.text)) if (!facts.hosts.includes(host)) facts.hosts.push(host);
  }

  findings.push(...filesCheck(input.type, input.files));
  if (input.type === "suit") findings.push(...sceneCheck(input.files));
  findings.push(...hiddenEntryFindings(input));

  const entryRules: readonly EntryRule[] =
    input.type === "spade-plugin" ? pluginRules : input.type === "spade-bot" ? recipeRules : [];
  for (const rule of entryRules)
    for (const hit of rule.find(input, facts))
      findings.push(
        mkFinding(rule.check, rule.id, rule.level, hit.message, hit.path, hit.line, rule.strict),
      );

  const hashed = hashFiles(input.files);
  const hash = contentHash(hashed);
  if (input.context.blocklist)
    findings.push(...knownBadFindings(input.files, hash, input.context.blocklist));

  return report(findings, { files: state.files, textBytes: state.textBytes }, hash);
}

/** A whole scan in one call, as the signer and the device run it. */
export function scanEntry(input: ScanInput): MarketScanReport {
  let state = startScan();
  for (;;) {
    const stepped = scanStep(state, input, wholeBudget);
    state = stepped.state;
    if (stepped.done) break;
  }
  return finishScan(state, input);
}

/** A listing edit or changelog (ADR 0173 §5): hidden unicode, links, injection, impersonation. */
export function scanListing(
  listing: Partial<MarketListingEdit> & { changelog?: string },
  context: ScanContext,
): MarketScanReport {
  const findings: MarketScanFinding[] = [];
  const fields: [string, string | undefined][] = [
    ["title", listing.title],
    ["line", listing.line],
    ["description", listing.description],
    ["changelog", listing.changelog],
  ];
  for (const [field, value] of fields) {
    if (!value) continue;
    if (hasBidi(value))
      findings.push(
        mkFinding(
          "hidden",
          "bidi-name",
          "block",
          `The ${field} holds a bidirectional control character`,
        ),
      );
    if (hasInvisible(value))
      findings.push(
        mkFinding("hidden", "invisible-name", "block", `The ${field} holds a hidden character`),
      );
    const mixed = mixedScriptWord(value);
    if (mixed)
      findings.push(
        mkFinding(
          "hidden",
          "mixed-script",
          "warn",
          `The ${field} word "${mixed}" mixes letters from more than one script`,
        ),
      );
  }
  if (listing.title && !context.publisher?.official) {
    const title = listing.title;
    if (readsAsAce(skeleton(title)) || readsAsAce(skeleton(title.replace(/^by\s+/i, ""))))
      findings.push(mkFinding("hidden", "reads-as-ace", "block", 'The title reads as "ace"'));
  }
  for (const link of listing.links ?? []) {
    const problem = linkProblem(link as MarketLink);
    if (problem) findings.push(mkFinding("files", "bad-link", "warn", problem.message));
  }
  return report(findings, { files: 0, textBytes: 0 });
}

/** Only the known-bad check, for re-checking installed bytes when a new blocklist arrives. */
export function knownBad(
  files: readonly ArchiveFile[],
  hash: string,
  blocklist: MarketBlocklist,
): MarketScanFinding[] {
  return knownBadFindings(files, hash, blocklist);
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
