import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import type { CorpusSample } from "./corpus-malicious.ts";
import { flowBenign, flowCorpus } from "./corpus-r2-flow.ts";
import { disposition, scanEntry, type ScanContext } from "./index.ts";

/*
 * The data-flow rule (ADR 0174 §8): a sensitive value reaching the network across lines is caught
 * where a one-line regex missed it, and ordinary config reads stay clean. Each malicious sample
 * fails before the fix.
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

describe("data flows from a secret to the network", () => {
  it.each(flowCorpus.map((sample) => [sample.id, sample] as const))(
    "%s is caught",
    (_id, sample) => {
      const { report, outcome } = scanned(sample);
      if (sample.expect === "block") expect(report.verdict).toBe("block");
      else expect(outcome).not.toBe("list");
    },
  );

  it("catches every flow sample", () => {
    const caught = flowCorpus.filter((sample) => scanned(sample).outcome !== "list");
    expect(caught.length).toBe(flowCorpus.length);
  });

  it.each(flowBenign.map((sample) => [sample.id, sample] as const))(
    "%s stays clean",
    (_id, sample) => {
      expect(scanned(sample).report.verdict).toBe("pass");
    },
  );
});
