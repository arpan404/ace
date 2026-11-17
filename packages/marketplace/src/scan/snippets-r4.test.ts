import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import type { CorpusSample } from "./corpus.ts";
import { benignSnippetSamples, unreadableSnippetSamples } from "./corpus-r4-snippets.ts";
import { scanEntry, type ScanContext } from "./index.ts";

/*
 * Instruction snippets fail closed (ADR 0173 §8): a command an agent is told to run that the
 * shell reader can't read for sure is held, whether it sits in a `sh` fence, an untagged fence,
 * an inline span, a command line or a fence in a file the rules read whole. Ordinary docs pass.
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

const heldAt: Record<keyof typeof unreadableSnippetSamples, string> = {
  shEvalVariable: "SKILL.md",
  untaggedBacktick: "SKILL.md",
  commandLineProcess: "SKILL.md",
  inlineEval: "SKILL.md",
  shEvalSubName: "SKILL.md",
  promptHandoff: "SKILL.md",
  readmeFence: "README.md",
};

describe("an instruction snippet the reader can't read", () => {
  for (const [name, sample] of Object.entries(unreadableSnippetSamples)) {
    it(`is held: ${sample.id}`, () => {
      const report = scanned(sample);
      expect(report.verdict).toBe("warn");
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          rule: "unreadable",
          level: "warn",
          path: heldAt[name as keyof typeof heldAt],
        }),
      );
    });
  }
});

describe("ordinary instructions", () => {
  for (const sample of Object.values(benignSnippetSamples)) {
    it(`pass clean: ${sample.id}`, () => {
      const report = scanned(sample);
      expect(report.findings).toEqual([]);
      expect(report.verdict).toBe("pass");
    });
  }
});
