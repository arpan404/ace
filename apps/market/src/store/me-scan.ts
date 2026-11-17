import { verifyBlocklist } from "@ace/marketplace";
import { checkArchive, type CheckedEntry } from "@ace/marketplace/checks";
import {
  finishScan,
  requestBudget,
  scanStep,
  startScan,
  type ScanContext,
  type ScanInput,
  type ScanState,
} from "@ace/marketplace/scan";
import {
  MarketKeySet,
  type MarketBlocklist,
  type MarketEntryType,
  type MarketScanReport,
} from "@ace/protocol/marketplace";
import { fromCatalogues, type Databases } from "./databases.ts";
import { verifiedNames } from "./profiles.ts";

/*
 * Running the scanner on the Worker (ADR 0173 §8): what it compares names against, the reports in
 * R2, and one budgeted step at a time. Each step reads the draft's archive again from R2; the
 * scanner's own resumable state is kept in `scan_jobs`.
 */

/** The verified blocklist, if one is stored and verifies with the market's keys. */
async function storedBlocklist(
  moderation: D1Database,
  publicKeys: string | undefined,
): Promise<MarketBlocklist | undefined> {
  const row = await moderation
    .prepare("SELECT signed FROM blocklist WHERE id = 1")
    .first<{ signed: string }>();
  if (!row || !publicKeys) return undefined;
  try {
    const keys = MarketKeySet.safeParse(JSON.parse(publicKeys)).data;
    return keys ? verifyBlocklist(JSON.parse(row.signed), keys) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the scanner compares an entry against: the market's entries over every catalogue, the
 * verified publishers, and the blocklist.
 */
export async function scanContext(
  dbs: Databases,
  publisher: { handle: string; official: boolean },
  publicKeys: string | undefined,
): Promise<ScanContext> {
  const [entries, verified, blocklist] = await Promise.all([
    fromCatalogues(dbs, async ({ db }) => {
      const { results } = await db
        .prepare(
          `SELECT e.type, e.name, p.name AS publisher,
            (SELECT COALESCE(SUM(v.counted), 0) FROM versions v
              WHERE v.type = e.type AND v.name = e.name) AS downloads
            FROM entries e JOIN publisher_copies p ON p.id = e.publisher LIMIT 50000`,
        )
        .all<{ type: string; name: string; publisher: string; downloads: number }>();
      return results;
    }),
    verifiedNames(dbs.publishers),
    storedBlocklist(dbs.moderation, publicKeys),
  ]);
  return {
    entries: entries.slice(0, 50000),
    verified,
    publisher,
    ...(blocklist ? { blocklist } : {}),
  };
}

export function scanInput(
  type: MarketEntryType,
  name: string,
  checked: CheckedEntry,
  context: ScanContext,
): ScanInput {
  return {
    type,
    name,
    files: checked.files,
    listing: checked.listing,
    inspection: checked.problems.length === 0 ? checked.inspection : undefined,
    context,
  };
}

/** A scan as far as one request's budget reaches: its report when done, else its state. */
export function scanWithin(
  input: ScanInput,
  from: ScanState = startScan(),
): { done: true; report: MarketScanReport } | { done: false; state: ScanState } {
  const step = scanStep(from, input, requestBudget);
  if (!step.done) return { done: false, state: step.state };
  return { done: true, report: finishScan(step.state, input) };
}

export const readChecked = (type: MarketEntryType, name: string, bytes: Uint8Array) =>
  checkArchive(type, name, bytes);

export async function putReport(
  bucket: R2Bucket,
  key: string,
  report: MarketScanReport,
): Promise<void> {
  await bucket.put(key, JSON.stringify(report), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** A report this Worker wrote (ADR 0125). */
export async function getReport(
  bucket: R2Bucket,
  key: string,
): Promise<MarketScanReport | undefined> {
  const stored = await bucket.get(key);
  return stored ? ((await stored.json()) as MarketScanReport) : undefined;
}

/** The first block's sentence: the plain reason a blocked version shows. */
export const blockReason = (report: MarketScanReport) =>
  (
    report.findings.find((finding) => finding.level === "block")?.message ??
    "The scan refused these files."
  ).slice(0, 500);
