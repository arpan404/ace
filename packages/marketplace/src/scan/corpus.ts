import type { MarketEntryType, MarketScanReport } from "@ace/protocol/marketplace";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import { disposition, scanEntry, type ScanContext, type ScanInput } from "./index.ts";

/*
 * The corpus harness the detection and false-positive tests share (ADR 0174 §8, Tests). A sample
 * is a folder of files written for these tests; `scanSample` runs the whole scanner over it, as
 * the signer and the device do. The benign samples live in `corpus-benign.ts` (`benignSamples`)
 * and the malicious ones in `corpus-malicious.ts`; this harness scores the benign side in
 * `corpus-benign.test.ts`. No sample runs; each only exhibits a pattern as inert text.
 */

export interface CorpusSample {
  /** A short id for the test report. */
  id: string;
  type: MarketEntryType;
  name: string;
  /**
   * The entry's files, path to text. A path ending in `*` is executable (the star is dropped), as
   * {@link folder} reads it. Binary samples pass raw bytes as a `Uint8Array`.
   */
  files: Record<string, string | Uint8Array>;
  /** The scan context, when a sample needs seeded entries or a blocklist. */
  context?: ScanContext;
  /** Which category the sample exercises, for the detection report. */
  category?: string;
}

const emptyContext: ScanContext = { entries: [], verified: [] };

/** The {@link ScanInput} for a sample: its folder checked for format, then the scan context. */
export function sampleInput(sample: CorpusSample): ScanInput {
  const files = folder(sample.files);
  const checked = checkFiles(sample.type, sample.name, files);
  return {
    type: sample.type,
    name: sample.name,
    files,
    listing: {
      title: checked.listing.title,
      line: checked.listing.line,
      description: checked.listing.description,
      keywords: checked.listing.keywords,
    },
    inspection: checked.inspection,
    context: sample.context ?? emptyContext,
  };
}

/** Runs the whole scanner over a sample, as the signer and the device do. */
export function scanSample(sample: CorpusSample): MarketScanReport {
  return scanEntry(sampleInput(sample));
}

/**
 * What a sample's scan means for a brand-new publisher's first upload, the strictest real case:
 * a block or a hold counts as caught. Used by the detection test to score the malicious corpus.
 */
export function caughtForNewPublisher(report: MarketScanReport): boolean {
  const call = disposition(report, {
    newPublisher: true,
    firstVersion: false,
    official: false,
    approved: false,
  });
  return call !== "list";
}
