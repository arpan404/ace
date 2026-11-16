import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder, sampleSkill } from "../testing.ts";
import { maliciousCorpus } from "./corpus-malicious.ts";
import {
  finishScan,
  scanEntry,
  scanStep,
  startScan,
  type ScanContext,
  type ScanInput,
} from "./index.ts";

/*
 * Invariants a review asked to pin down (ADR 0173 §8): a scan the device and the Worker run on the
 * same bytes agrees, and a scan that didn't finish reading every file is never a pass.
 */

const context: ScanContext = { entries: [], verified: [] };

function inputFor(sample: { type: ScanInput["type"]; name: string; files: ScanInput["files"] }) {
  const files = folder(sample.files as Record<string, string | Uint8Array>);
  const checked = checkFiles(sample.type, sample.name, files);
  return {
    type: sample.type,
    name: sample.name,
    files,
    listing: checked.listing,
    inspection: checked.inspection,
    context,
  } satisfies ScanInput;
}

describe("the scan is the same whatever reads it", () => {
  it("agrees on every malicious sample whole and step by step", () => {
    // The device scans whole (wholeBudget via scanEntry); the Worker scans in request-sized
    // steps. For the same bytes they must reach the same verdict and findings.
    const tiny = { textBytes: 64, files: 1 };
    for (const sample of maliciousCorpus) {
      const input = inputFor(sample);
      const whole = scanEntry(input);
      let state = startScan();
      for (;;) {
        const step = scanStep(state, input, tiny);
        state = step.state;
        if (step.done) break;
      }
      const stepped = finishScan(state, input);
      expect(stepped.verdict, sample.id).toBe(whole.verdict);
      expect(stepped.findings.map((f) => f.rule).toSorted()).toEqual(
        whole.findings.map((f) => f.rule).toSorted(),
      );
    }
  });
});

describe("a scan that didn't finish is never a pass", () => {
  it("blocks when files are left unread", () => {
    const input = inputFor({
      type: "spade-skill",
      name: "many",
      files: {
        "SKILL.md": "---\nname: many\ndescription: Does a chore.\n---\n# many\n",
        "a.txt": "one",
        "b.txt": "two",
        "c.txt": "three",
      },
    });
    // One file read, the rest left: finishScan must not pass.
    const step = scanStep(startScan(), input, { textBytes: 1, files: 1 });
    expect(step.done).toBe(false);
    const report = finishScan(step.state, input);
    expect(report.verdict).toBe("block");
    expect(report.findings.some((f) => f.rule === "scan-incomplete")).toBe(true);
  });

  it("passes a clean entry once every file is read", () => {
    const files = sampleSkill("tidy");
    const checked = checkFiles("spade-skill", "tidy", files);
    const report = scanEntry({
      type: "spade-skill",
      name: "tidy",
      files,
      listing: checked.listing,
      inspection: checked.inspection,
      context,
    });
    expect(report.verdict).toBe("pass");
    expect(report.findings.some((f) => f.rule === "scan-incomplete")).toBe(false);
  });
});
