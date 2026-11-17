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
import { checkArchive } from "./checks/index.ts";
import { disposition, scanEntry, type ScanContext } from "./scan/index.ts";
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
}

/** Signs every pending version that passes the checks again, and any pending withdrawals. */
export async function signPending(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
  trusted: MarketKeySet,
): Promise<SignerReport> {
  const pending = SignerPending.parse(await io.get("/v1/signer/pending"));
  const report: SignerReport = {
    signed: [],
    refused: [],
    blocked: [],
    held: [],
    failed: [],
    withdrawn: 0,
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
    if (scanning) {
      const official = version.publisher.id === scanning.official;
      const scan = scanEntry({
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
export {
  signBlocklistChange,
  signOfficialChange,
  signVerifiedChange,
  signWithdrawAll,
  type BlocklistChange,
} from "./signer-lists.ts";
