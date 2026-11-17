import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import type { CorpusSample } from "./corpus.ts";
import { benignSplitSamples, splitIntentSamples } from "./corpus-r4-intent.ts";
import { scanEntry, type ScanContext } from "./index.ts";

/*
 * Execution intent spans a document (ADR 0173 §8, fail closed): a download or a decode anywhere
 * in an instruction source, paired with a run anywhere in it, holds the source at the run line.
 * A doc link beside a concrete safe command, or a pinned install, stays a pass.
 */

const context: ScanContext = { entries: [], verified: [] };

function scanned(sample: CorpusSample) {
  const files = folder(sample.files);
  const checked = checkFiles(sample.type, sample.name, files);
  return scanEntry({
    type: sample.type,
    name: sample.name,
    files,
    listing: checked.listing,
    inspection: checked.inspection,
    context,
  });
}

function intentOf(sample: CorpusSample) {
  const report = scanned(sample);
  expect(report.verdict).not.toBe("pass");
  return report.findings.find((finding) => finding.rule === "instruction-intent");
}

describe("intent split across a document", () => {
  it("a download and 'then run it' in two sentences is held at the run", () => {
    expect(intentOf(splitIntentSamples.twoSentences)).toMatchObject({
      level: "warn",
      path: "SKILL.md",
      line: 6,
    });
  });

  it("a fetch and a run two paragraphs later is held at the run's line", () => {
    expect(intentOf(splitIntentSamples.twoParagraphs)).toMatchObject({
      level: "warn",
      path: "SKILL.md",
      line: 10,
    });
  });

  it("a run that names what an earlier sentence fetched is held", () => {
    expect(intentOf(splitIntentSamples.namedLater)).toMatchObject({ path: "SKILL.md", line: 8 });
  });

  it("an encoded blob and a later 'run the result' is held", () => {
    expect(intentOf(splitIntentSamples.decodeThenRun)).toMatchObject({ path: "SKILL.md", line: 8 });
  });

  it("a download in a recipe's note and 'run it' in a routine is held at the routine", () => {
    expect(intentOf(splitIntentSamples.recipeNoteRoutine)).toMatchObject({
      level: "warn",
      path: "recipe:routine/nightly",
    });
  });
});

describe("ordinary docs with a link and a run", () => {
  it.each(benignSplitSamples.map((sample) => [sample.id, sample] as const))(
    "%s stays a pass",
    (_id, sample) => {
      const report = scanned(sample);
      expect(report.findings).toEqual([]);
      expect(report.verdict).toBe("pass");
    },
  );
});
