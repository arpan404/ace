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
import { secretFileProblem, secretValueProblems } from "../secrets.ts";
import { filesCheck } from "./checks-files.ts";
import { hiddenEntryFindings, hiddenFileFindings } from "./checks-hidden.ts";
import { knownBadFindings } from "./checks-knownbad.ts";
import { sceneCheck } from "./checks-scene.ts";
import { pluginRules } from "./rules-plugin.ts";
import { recipeRules } from "./rules-recipe.ts";
import { flowEntryRules, flowRules } from "./rules-flow.ts";
import { scriptRules } from "./rules-scripts.ts";
import type { EntryRule, ScanFacts } from "./rule.ts";
import { scanText } from "./decode.ts";
import { held, truncated } from "./fail-closed.ts";
import { safeBinary } from "./binary.ts";
import { runnableContent, type Runnable } from "./runnable.ts";
import { instructionFile, instructionTruncations } from "./instructions.ts";
import {
  commandViews,
  fileScriptView,
  hostsIn,
  isScriptLike,
  namedScripts,
  type NamedScript,
  type ScriptView,
} from "./script-view.ts";
import { hasBidi, hasInvisible, mixedScriptWord } from "./text.ts";
import { linkProblem, readsAsAce, skeleton } from "../profile.ts";
import type { MarketLink } from "@ace/protocol/marketplace";

/** The most text read from one file (ADR 0174 §8): past it a script is a `warn`, not read whole. */
const MAX_FILE_BYTES = 1024 * 1024;

/*
 * The scanner (ADR 0174 §8): one pure module the Worker, the signer and the device run on the
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
  /** Verified publishers' handles and display names (ADR 0174 §13). */
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
/** A Worker request's budget (ADR 0174 §8): 4 MiB of text or 600 files. */
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
function scanFile(
  input: ScanInput,
  file: ArchiveFile,
  state: ScanState,
  script: NamedScript | undefined,
): number {
  const named = secretFileProblem(file.path);
  if (named)
    state.findings.push(mkFinding("secrets", "secret-file", "block", named.message, file.path));

  const decoded = scanText(file.content);
  if (decoded === undefined) {
    // A file the scanner can't decode as text (ADR 0174 §8, finding 1). The `files` check reads
    // its first bytes for a known-bad format; on top of that, an executable file, an
    // instruction-referenced one, a script-like name or location, or any binary that isn't a
    // recognised safe data format is held — never passed on unrecognised magic.
    const referenced = isScriptLike(file.path, "", script) || file.executable;
    if (referenced || !safeBinary(file.content, file.path))
      state.findings.push(
        held(
          "files",
          "unreadable-binary",
          `${file.path} can't be read and isn't a recognised data file`,
          file.path,
        ),
      );
    return 0;
  }
  const source = decoded.text;
  if (decoded.encoding !== "utf-8" && isScriptLike(file.path, source, script))
    state.findings.push(
      mkFinding(
        "scripts",
        "not-utf8",
        "warn",
        `${file.path} is a script that isn't UTF-8 text`,
        file.path,
        undefined,
        true,
      ),
    );

  const tooLong = file.content.byteLength > MAX_FILE_BYTES;
  const text = tooLong ? source.slice(0, MAX_FILE_BYTES) : source;
  if (tooLong) {
    // Executable or instructional content the scanner couldn't read whole is blocked (fail
    // closed, ADR 0174 §8): a buried `curl … | sh` past the cap can't slip through. A plain data
    // file isn't executable, so truncating its scan isn't a gap.
    const scripty = isScriptLike(file.path, source, script) || instructionFile.test(file.path);
    state.findings.push(
      scripty
        ? truncated("scripts", `${file.path} is too long to read whole`, file.path)
        : mkFinding(
            "scripts",
            "too-long",
            "warn",
            `${file.path} is too long to read fully`,
            file.path,
            undefined,
            true,
          ),
    );
  }

  for (const problem of secretValueProblems(text, file.path))
    state.findings.push(
      mkFinding("secrets", "secret-value", "block", problem.message, file.path, problem.line),
    );

  // A single-byte reading holds no code point past U+00FF, so no bidi or zero-width character:
  // what reads as one (U+00AD) is only a byte.
  if (decoded.encoding !== "single-byte")
    state.findings.push(...hiddenFileFindings(file.path, text));

  const hosts = (state.facts["hosts"] ??= []);
  for (const host of hostsIn(text)) if (!hosts.includes(host)) hosts.push(host);

  const view = fileScriptView(input.type, file.path, text, script);
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
  for (const rule of [...scriptRules, ...flowRules])
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
  const named = namedScripts(input);
  let readFiles = 0;
  let readBytes = 0;
  while (next.cursor < files.length && readFiles < budget.files && readBytes < budget.textBytes) {
    const file = files[next.cursor];
    if (file) {
      readBytes += scanFile(input, file, next, named.get(file.path));
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

  // A scan that never read every file (a budget ran out, a step was skipped) is never a pass:
  // an unread file could hide a block. The Worker only calls this once a scan is done; this
  // guard holds the invariant even for a direct, cut-short call (ADR 0174 §8).
  if (state.cursor < sortedFiles(input).length)
    findings.push(
      mkFinding(
        "files",
        "scan-incomplete",
        "block",
        "The scan didn't finish reading this entry, so it can't be listed.",
        undefined,
        undefined,
        false,
      ),
    );
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
  // An instruction cap that dropped executable text surfaces as a block (fail closed, §8).
  findings.push(...instructionTruncations(input));

  // The recipe rules (prompt injection in SKILL.md, connectors) filter by type themselves, so
  // they run on skills and plugins as well as recipes; the plugin rules run on plugins.
  const entryRules: readonly EntryRule[] = [
    ...(input.type === "spade-plugin" ? pluginRules : []),
    ...(input.type === "spade-plugin" || input.type === "spade-skill" || input.type === "spade-bot"
      ? [...recipeRules, ...flowEntryRules]
      : []),
  ];
  for (const rule of entryRules)
    for (const hit of rule.find(input, facts))
      findings.push(
        mkFinding(rule.check, rule.id, rule.level, hit.message, hit.path, hit.line, rule.strict),
      );

  const hashed = hashFiles(input.files);
  const hash = contentHash(hashed);
  if (input.context.blocklist)
    findings.push(...knownBadFindings(input.files, hash, input.context.blocklist));

  return report(
    findings,
    { files: state.files, textBytes: state.textBytes },
    hash,
    runnableContent(input),
  );
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

/** A listing edit or changelog (ADR 0174 §5): hidden unicode, links, injection, impersonation. */
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

/** What a report means for listing (ADR 0174 §9). */
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
  // The policy layer (ADR 0174 §8): a version with runnable content is held for a maintainer on
  // scan pass alone, whatever the publisher. Only pure data lists without review.
  if (scan.runnable) return "hold";
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

/** What each check says when it found nothing to hold or refuse. */
const passSentences: Record<MarketScanCheckId, string> = {
  files: "No programs or archives inside.",
  scripts: "Its scripts do nothing ace refuses.",
  scene: "Its scene stays inside its sandbox.",
  plugin: "Its commands and servers match what it declares.",
  recipe: "Its instructions keep to its task.",
  secrets: "No keys or passwords inside.",
  hidden: "No hidden characters or look-alike names.",
  "known-bad": "Nothing on ace's blocklist.",
};

/** A check in one sentence: what it passed, or its first finding and how many more. */
function checkSentence(
  id: MarketScanCheckId,
  verdict: "pass" | "warn" | "block",
  own: readonly MarketScanFinding[],
): string {
  const weighty = own.filter((finding) => finding.level !== "note");
  const first = weighty[0];
  if (verdict === "pass" || !first) return passSentences[id];
  const rest = weighty.length - 1;
  const lead = first.message.replace(/[.\s]+$/, "");
  const sentence = rest > 0 ? `${lead}, and ${rest} more.` : `${lead}.`;
  return sentence.length > 500 ? `${sentence.slice(0, 497)}...` : sentence;
}

/** A report from findings: each check's verdict from its own, the whole from all. */
export function report(
  findings: readonly MarketScanFinding[],
  read: { files: number; textBytes: number },
  hash?: string,
  runnable: Runnable = { runnable: false },
): MarketScanReport {
  return {
    format: "ace-market-scan",
    scanner: marketScannerVersion,
    ...(hash ? { hash } : {}),
    verdict: verdictOf(findings),
    runnable: runnable.runnable,
    ...(runnable.reason ? { runnableReason: runnable.reason } : {}),
    checks: checkOrder.map((id) => {
      const own = findings.filter((finding) => finding.check === id);
      const verdict = verdictOf(own);
      return {
        id,
        verdict,
        sentence: checkSentence(id, verdict, own),
        findings: own.length,
      };
    }),
    findings: findings.slice(0, 500),
    truncated: findings.length > 500,
    read,
  };
}
