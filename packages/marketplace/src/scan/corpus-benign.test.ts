import { describe, expect, it } from "vitest";
import { benignSamples } from "./corpus-benign.ts";
import { scanSample } from "./corpus.ts";

/*
 * The benign corpus's false positives (ADR 0173 §8, Tests): the scanner must never block a real,
 * useful entry. Every benign sample is scanned; none may be blocked, and the number that draw a
 * warn is reported for the README. The detection side (malicious caught) lives in
 * detection.test.ts.
 */

describe("the scanner on the benign corpus", () => {
  it.each(benignSamples.map((sample) => [sample.id, sample] as const))(
    "does not block %s",
    (_id, sample) => {
      const report = scanSample(sample);
      const blocked = report.findings.filter((finding) => finding.level === "block");
      expect(blocked, blocked.map((f) => `${f.rule}: ${f.message}`).join("; ")).toHaveLength(0);
      expect(report.verdict).not.toBe("block");
    },
  );

  it("blocks none of the benign corpus and keeps warns low", () => {
    const reports = benignSamples.map((sample) => scanSample(sample));
    const blocks = reports.filter((report) => report.verdict === "block").length;
    const warns = reports.filter((report) => report.verdict === "warn").length;
    expect(blocks).toBe(0);
    // Warns are allowed on benign entries but should be rare; a regression that warns on most of
    // the corpus means a rule has become too eager.
    expect(warns / reports.length).toBeLessThan(0.1);
  });

  it("covers all four entry types", () => {
    const types = new Set(benignSamples.map((sample) => sample.type));
    expect(types).toEqual(new Set(["spade-skill", "spade-plugin", "suit", "spade-bot"]));
    expect(benignSamples.length).toBeGreaterThanOrEqual(40);
  });
});
