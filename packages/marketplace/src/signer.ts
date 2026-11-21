import { botJsonOf, breaksReason, contractBreaks, latestPublished } from "./published.ts";
import { addWithdrawals, label, versionPath, type SignerIo } from "./signer-io.ts";
import {
  MarketScanContextBody,
  SignerPending,
  VersionBody,
  type MarketBlocklist,
  type MarketEntryType,
  type MarketKeySet,
  type MarketScanReport,
  type Withdrawal,
} from "@ace/protocol/marketplace";
import type { ArchiveFile } from "./archive.ts";
import { checkArchive } from "./checks/index.ts";
import { disposition, scanEntry, type ScanContext } from "./scan/index.ts";
import { failedTestsReport, hasBotTests, testsReason, type BotTestRunner } from "./signer-tests.ts";
import { codeReason, hasCode, readCode, type CodeChecker } from "./signer-code.ts";
import {
  signManifest,
  signReviewMark,
  verifyBlocklist,
  verifyManifest,
  verifyOfficialList,
  type MarketSigningKey,
} from "./signing.ts";

/*
 * The maintainer's signer (ADR 0168 §6, `ace market sign`). It runs on a maintainer's machine
 * with the key from a file; the Worker never holds it. It pulls the versions that passed the
 * Worker's checks, runs the same checks again on the bytes the Worker stored, and signs only
 * what passes. What it reads back (the withdrawn list, a version's manifest) is checked against
 * the trusted key set, not only the key signing now, so a rotation keeps both working. The I/O
 * is passed in, so the same core runs against the real market or a test's.
 *
 * Before signing it scans again (ADR 0174 §8) with the newest blocklist and the market's scan
 * context: a block is refused for good, a warn a maintainer hasn't approved is held for one, and
 * so is every version by the official publisher (and a new publisher's strict notes).
 *
 * A bot package's WebAssembly components are read first, by Spade's own program (ADR 0203 §5):
 * a component outside Spade's world, or whose imports differ from its entry, refuses the version
 * for good; when this machine can't read them, it isn't signed and waits for one that can.
 *
 * A bot package's own tests run last, before it is signed (ADR 0200 §8): failing, the version is
 * refused with each failure in its report; when this machine can't run them, it isn't signed and
 * waits for a signer that can.
 */

export interface SignerReport {
  signed: string[];
  refused: { version: string; problems: string[] }[];
  /** Blocked by the scan, with the reason the publisher reads. */
  blocked: { version: string; reason: string }[];
  /** Held for a maintainer, with the findings as sentences. */
  held: { version: string; findings: string[] }[];
  failed: { what: string; status: number; text: string }[];
  withdrawn: number;
  /** Bot packages whose tests passed here, with how many scenarios ran. */
  tested: { version: string; scenarios: number }[];
}

export interface SignerOptions {
  /** Runs a bot package's scenarios; without it, a bot package with tests isn't signed. */
  testBot?: BotTestRunner | undefined;
  /** Reads a bot package's components; without it, a bot package with code isn't signed. */
  checkCode?: CodeChecker | undefined;
  /**
   * Signing for an organization's registry (ADR 0206 §5.2): each manifest names it, and earlier
   * versions are read back against its chain's keys. The signed lists are still ace's, checked
   * against `trusted`.
   */
  registry?: { org: string; keys: MarketKeySet } | undefined;
}

/** Signs every pending version that passes the checks again, and any pending withdrawals. */
export async function signPending(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  options: SignerOptions = {},
): Promise<SignerReport> {
  const pending = SignerPending.parse(await io.get("/v1/signer/pending"));
  const report: SignerReport = {
    signed: [],
    refused: [],
    blocked: [],
    held: [],
    failed: [],
    withdrawn: 0,
    tested: [],
  };
  const scanning =
    pending.versions.length > 0 ? await scanSetting(io, pending, trusted) : undefined;
  for (const version of pending.versions) {
    const checked = checkArchive(version.type, version.name, await io.object(version.hash));
    const problems = checked.problems.map((problem) =>
      problem.path ? `${problem.path}: ${problem.message}` : problem.message,
    );
    if (checked.hash !== version.hash)
      problems.push("The stored bytes don't hash to the version's hash");
    if (problems.length > 0) {
      report.refused.push({ version: label(version), problems });
      continue;
    }
    // Its code, read from the binary before a maintainer is asked to look at it.
    if (hasCode(checked.inspection)) {
      const code = await readCode(options.checkCode, checked.files);
      if ("refused" in code) {
        report.refused.push({ version: label(version), problems: [code.refused] });
        continue;
      }
      if (code.problems.length > 0) {
        const reason = codeReason(code);
        const answer = await io.put(versionPath("blocks", version), { reason });
        if (answer.status >= 200 && answer.status < 300)
          report.blocked.push({ version: label(version), reason });
        else report.failed.push({ what: label(version), ...answer });
        continue;
      }
    }
    let scan: MarketScanReport | undefined;
    if (scanning) {
      const official = version.publisher.id === scanning.official;
      scan = scanEntry({
        type: version.type,
        name: version.name,
        files: checked.files,
        listing: checked.listing,
        inspection: checked.inspection,
        context: {
          ...scanning.context,
          publisher: { handle: version.publisher.name, official },
        },
      });
      const fate = disposition(scan, {
        newPublisher: scanning.newPublishers.has(version.publisher.name),
        // The Worker held a new publisher's first version already; this is a later look.
        firstVersion: false,
        official,
        approved: version.approved === true,
      });
      if (fate === "block") {
        const reason = blockReason(scan);
        const answer = await io.put(versionPath("blocks", version), { reason, scan });
        if (answer.status >= 200 && answer.status < 300)
          report.blocked.push({ version: label(version), reason });
        else report.failed.push({ what: label(version), ...answer });
        continue;
      }
      if (fate === "hold") {
        // The scan goes with it: the queue shows this look, not the Worker's older one.
        const answer = await io.put(versionPath("holds", version), { decision: "hold", scan });
        if (answer.status >= 200 && answer.status < 300)
          report.held.push({ version: label(version), findings: sentences(scan) });
        else report.failed.push({ what: label(version), ...answer });
        continue;
      }
    }
    // A bot package may not break the bots that call its contracts (ADR 0200 §7): a version
    // whose contracts break the latest signed one's is refused for good, with each change.
    if (version.type === "spade-bot") {
      const compared = await compareContracts(
        io,
        version,
        checked.files,
        options.registry?.keys ?? trusted,
      );
      if ("refused" in compared) {
        report.refused.push({ version: label(version), problems: [compared.refused] });
        continue;
      }
      if (compared.reason) {
        const body = scan ? { reason: compared.reason, scan } : { reason: compared.reason };
        const answer = await io.put(versionPath("blocks", version), body);
        if (answer.status >= 200 && answer.status < 300)
          report.blocked.push({ version: label(version), reason: compared.reason });
        else report.failed.push({ what: label(version), ...answer });
        continue;
      }
    }
    if (hasBotTests(checked.inspection)) {
      const tests = await runTests(options.testBot, checked.files);
      if ("refused" in tests) {
        report.refused.push({ version: label(version), problems: [tests.refused] });
        continue;
      }
      if (!tests.passed) {
        const reason = testsReason(tests);
        const body = scan ? { reason, scan: failedTestsReport(scan, tests) } : { reason };
        const answer = await io.put(versionPath("blocks", version), body);
        if (answer.status >= 200 && answer.status < 300)
          report.blocked.push({ version: label(version), reason });
        else report.failed.push({ what: label(version), ...answer });
        continue;
      }
      report.tested.push({ version: label(version), scenarios: tests.scenarios });
    }
    const manifest = signManifest(
      {
        format: "ace-market-manifest",
        type: version.type,
        name: version.name,
        version: version.version,
        publisher: version.publisher,
        hash: checked.hash,
        files: checked.hashed,
        size: checked.size,
        published: version.published,
        key: key.id,
        ...(options.registry ? { registry: options.registry.org } : {}),
      },
      key,
    );
    const answer = await io.put(versionPath("versions", version), { manifest });
    if (answer.status >= 200 && answer.status < 300) report.signed.push(label(version));
    else report.failed.push({ what: label(version), ...answer });
  }
  if (pending.withdrawals.length > 0) {
    // A publisher's withdrawal names their version, never every copy of its bytes.
    const added: Withdrawal[] = pending.withdrawals.map((entry) => ({
      scope: "version",
      type: entry.type,
      name: entry.name,
      version: entry.version,
      hash: entry.hash,
      reason: entry.reason,
      at: entry.at,
    }));
    const answer = await addWithdrawals(io, key, now, trusted, pending, added);
    if (answer.status >= 200 && answer.status < 300) report.withdrawn = answer.added;
    else
      report.failed.push({ what: "the withdrawn list", status: answer.status, text: answer.text });
  }
  return report;
}

/**
 * The latest signed version of the same package before this one, and what this one's contracts
 * break for its callers: a reason to refuse, none, or why it couldn't be read (then nothing is
 * signed this run).
 */
async function compareContracts(
  io: SignerIo,
  version: { name: string; version: string },
  files: readonly ArchiveFile[],
  trusted: MarketKeySet,
): Promise<{ reason: string | undefined } | { refused: string }> {
  try {
    const previous = await latestPublished(
      { read: (path) => (io.read ?? io.get)(path), object: (hash) => io.object(hash) },
      version.name,
      { before: version.version, keys: trusted },
    );
    if (!previous) return { reason: undefined };
    const breaks = contractBreaks(previous.bot, botJsonOf(files));
    return { reason: breaks.length ? breaksReason(previous.version, breaks) : undefined };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      refused: `Its contracts couldn't be compared with its last version: ${why}`.slice(0, 500),
    };
  }
}

/** A package's tests, or why they couldn't run here: then nothing is signed or refused. */
async function runTests(testBot: BotTestRunner | undefined, files: Parameters<BotTestRunner>[0]) {
  if (!testBot)
    return {
      refused:
        "Its tests need Spade's program, which this signer doesn't have; it waits for one that does.",
    };
  try {
    return await testBot(files);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { refused: `Its tests couldn't run here: ${why}`.slice(0, 500) };
  }
}

/** What every scan in one signing run compares against. */
async function scanSetting(io: SignerIo, pending: SignerPending, trusted: MarketKeySet) {
  const body = MarketScanContextBody.parse(await io.get("/v1/signer/scan-context"));
  // Lists a trusted key signed only; an unsigned or foreign one is no list at all.
  const blocklist: MarketBlocklist | undefined = pending.blocklist
    ? verifyBlocklist(pending.blocklist, trusted)
    : undefined;
  const official = pending.official
    ? verifyOfficialList(pending.official, trusted).publisher.id
    : undefined;
  const context: ScanContext = {
    entries: body.entries,
    verified: body.verified,
    ...(blocklist ? { blocklist } : {}),
  };
  return { context, official, newPublishers: new Set(body.newPublishers) };
}

/** A finding as one line: where, then the sentence. */
export const findingSentence = (finding: MarketScanReport["findings"][number]) =>
  `${finding.path ? `${finding.path}${finding.line ? ` line ${finding.line}` : ""}: ` : ""}${finding.message}`;
const sentences = (scan: MarketScanReport) =>
  scan.findings.filter((finding) => finding.level !== "note").map(findingSentence);
/** Why a scan blocked, in the publisher's words. */
export function blockReason(scan: MarketScanReport): string {
  const first = scan.findings.find((finding) => finding.level === "block");
  return (first ? findingSentence(first) : "Refused by ace's scan.").slice(0, 500);
}

/**
 * A maintainer's revocation of bytes wherever they are listed (`ace market revoke`): its own
 * act, never what a publisher's withdrawal does.
 */
export async function signRevocation(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  revoke: { hash: string; reason: string },
): Promise<{ status: number; text: string }> {
  const pending = SignerPending.parse(await io.get("/v1/signer/pending"));
  const answer = await addWithdrawals(io, key, now, trusted, pending, [
    { scope: "hash", hash: revoke.hash, reason: revoke.reason, at: now() },
  ]);
  return { status: answer.status, text: answer.text };
}

/**
 * A maintainer's review mark on one listed version: the version's signed manifest is read back
 * and checked against this key first, so a mark only ever names bytes this signer signed.
 */
export async function signReview(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
  target: {
    type: MarketEntryType;
    name: string;
    version: string;
    reviewed: boolean;
    byAce: boolean;
  },
): Promise<{ status: number; text: string }> {
  const body = VersionBody.parse(
    await io.get(
      `/v1/entries/${encodeURIComponent(target.type)}/${encodeURIComponent(target.name)}/${encodeURIComponent(target.version)}`,
    ),
  );
  const manifest = verifyManifest(body.manifest, trusted);
  const review = signReviewMark(
    {
      format: "ace-market-review",
      type: target.type,
      name: target.name,
      hash: manifest.hash,
      reviewed: target.reviewed,
      byAce: target.byAce,
      at: now(),
      key: key.id,
    },
    key,
  );
  return io.put(versionPath("reviews", target), { review });
}

export { type SignerIo } from "./signer-io.ts";
export { type BotTestOutcome, type BotTestRunner } from "./signer-tests.ts";
export { type CodeCheckOutcome, type CodeChecker } from "./signer-code.ts";
export {
  signBlocklistChange,
  signNoticeChange,
  signOfficialChange,
  signVerifiedChange,
  signWithdrawAll,
  type BlocklistChange,
} from "./signer-lists.ts";
