import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import { maliciousCorpus, type CorpusSample } from "./corpus-malicious.ts";
import { disposition, scanEntry, type ScanContext } from "./index.ts";

/*
 * The scanner against the inert malicious corpus (ADR 0173 §8): every sample is refused or held,
 * as it says, and the detection rate is measured. The benign corpus's false positives are
 * measured beside it (corpus-benign.test.ts).
 */

const context: ScanContext = { entries: [], verified: [] };

function scanned(sample: CorpusSample) {
  const files = folder(sample.files);
  const checked = checkFiles(sample.type, sample.name, files);
  const report = scanEntry({
    type: sample.type,
    name: sample.name,
    files,
    listing: checked.listing,
    inspection: checked.inspection,
    context,
  });
  const outcome = disposition(report, {
    newPublisher: false,
    firstVersion: false,
    official: false,
    approved: false,
  });
  return { report, outcome };
}

describe("the scanner on the malicious corpus", () => {
  it.each(maliciousCorpus.map((sample) => [sample.id, sample] as const))(
    "%s is caught",
    (_id, sample) => {
      const { report, outcome } = scanned(sample);
      if (sample.expect === "block") expect(report.verdict).toBe("block");
      else expect(outcome).not.toBe("list");
      // Every refusal says why, in a sentence the publisher reads.
      expect(report.findings.some((finding) => finding.level !== "note")).toBe(true);
    },
  );

  it("catches at least 95% of the corpus, and every category", () => {
    const results = maliciousCorpus.map((sample) => Object.assign({ sample }, scanned(sample)));
    const caught = results.filter((result) => result.outcome !== "list");
    expect(caught.length / results.length).toBeGreaterThanOrEqual(0.95);
    const categories = new Set(results.map((result) => result.sample.category));
    for (const category of categories)
      expect(
        caught.some((result) => result.sample.category === category),
        category,
      ).toBe(true);
  });
});
