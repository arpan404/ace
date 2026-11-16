import type { MarketEntryType } from "@ace/protocol/marketplace";
import { checkArchive } from "./checks/index.ts";
import { VersionBody } from "./feed.ts";
import { SignerPending } from "./service-wire.ts";
import {
  marketPublicKey,
  signManifest,
  signReviewMark,
  signWithdrawn,
  verifyManifest,
  verifyWithdrawn,
  type MarketSigningKey,
} from "./signing.ts";

/*
 * The maintainer's signer (ADR 0168 §6, `ace market sign`). It runs on a maintainer's machine
 * with the key from a file; the Worker never holds it. It pulls the versions that passed the
 * Worker's checks, runs the same checks again on the bytes the Worker stored, and signs only
 * what passes. The I/O is passed in, so the same core runs against the real market or a test's.
 */

export interface SignerIo {
  /** GET a signer or read route; parsed JSON. */
  get(path: string): Promise<unknown>;
  /** The archive the Worker stored under `hash`, listed or not. */
  object(hash: string): Promise<Uint8Array>;
  /** PUT JSON to a signer route; resolves with the status and body text. */
  put(path: string, body: unknown): Promise<{ status: number; text: string }>;
}

export interface SignerReport {
  signed: string[];
  refused: { version: string; problems: string[] }[];
  failed: { what: string; status: number; text: string }[];
  withdrawn: number;
}

const label = (version: { type: string; name: string; version: string }) =>
  `${version.type}/${version.name}@${version.version}`;
const versionPath = (route: string, version: { type: string; name: string; version: string }) =>
  `/v1/signer/${route}/${encodeURIComponent(version.type)}/${encodeURIComponent(version.name)}/${encodeURIComponent(version.version)}`;

/** Signs every pending version that passes the checks again, and any pending withdrawals. */
export async function signPending(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
): Promise<SignerReport> {
  const pending = SignerPending.parse(await io.get("/v1/signer/pending"));
  const report: SignerReport = { signed: [], refused: [], failed: [], withdrawn: 0 };
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
    const ours = { keys: [marketPublicKey(key)] };
    const earlier = pending.withdrawn ? verifyWithdrawn(pending.withdrawn, ours).withdrawn : [];
    const known = new Set(earlier.map((entry) => entry.hash));
    const added = pending.withdrawals
      .filter((entry) => !known.has(entry.hash))
      .map((entry) => ({ hash: entry.hash, reason: entry.reason, at: entry.at }));
    const list = signWithdrawn(
      {
        format: "ace-market-withdrawn",
        issued: now(),
        withdrawn: [...earlier, ...added],
        key: key.id,
      },
      key,
    );
    const answer = await io.put("/v1/signer/withdrawn", { withdrawn: list });
    if (answer.status >= 200 && answer.status < 300) report.withdrawn = added.length;
    else report.failed.push({ what: "the withdrawn list", ...answer });
  }
  return report;
}

/**
 * A maintainer's review mark on one listed version: the version's signed manifest is read back
 * and checked against this key first, so a mark only ever names bytes this signer signed.
 */
export async function signReview(
  io: SignerIo,
  key: MarketSigningKey,
  now: () => number,
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
  const manifest = verifyManifest(body.manifest, { keys: [marketPublicKey(key)] });
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
