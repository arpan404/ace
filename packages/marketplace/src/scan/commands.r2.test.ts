import { describe, expect, it } from "vitest";
import { scanSample, type CorpusSample } from "./corpus.ts";
import { commandLookAlikes, commandSamples, operandLookAlikes } from "./corpus-r2-commands.ts";
import { disposition } from "./index.ts";

/*
 * Commands in instruction files and fetched files run past a shell's options (ADR 0174 §8): a
 * SKILL.md, README, plugin description or recipe text that tells an agent to run a download is
 * caught like a script that does, and `sh -eu x`, `source x`, `bash <(curl …)` count as running
 * what was fetched. Look-alikes that run nothing fetched stay clean.
 */

const outcome = (sample: CorpusSample) =>
  disposition(scanSample(sample), {
    newPublisher: false,
    firstVersion: false,
    official: false,
    approved: false,
  });

describe("commands an entry's instructions give an agent", () => {
  it.each(commandSamples.map((sample) => [sample.id, sample] as const))(
    "%s is caught",
    (_id, sample) => {
      expect(outcome(sample)).not.toBe("list");
      // Refused for running a download or hidden code, not only held as hard to read.
      expect(scanSample(sample).verdict).toBe("block");
    },
  );

  it("catches at least 95% of the samples", () => {
    const caught = commandSamples.filter((sample) => outcome(sample) !== "list");
    expect(caught.length / commandSamples.length).toBeGreaterThanOrEqual(0.95);
  });

  it("says where in the instruction file the command is", () => {
    const sample = commandSamples.find((each) => each.id === "fence-sh");
    if (!sample) throw new Error("fence-sh sample missing");
    const finding = scanSample(sample).findings.find((each) => each.rule === "download-exec");
    // SKILL.md: 4 lines of front matter, a blank, the prose, a blank, the fence, the command.
    expect(finding).toMatchObject({ path: "SKILL.md", line: 9 });
  });

  it.each(commandLookAlikes.map((sample) => [sample.id, sample] as const))(
    "%s stays clean",
    (_id, sample) => {
      const report = scanSample(sample);
      expect(report.findings).toEqual([]);
      expect(report.verdict).toBe("pass");
    },
  );

  it.each(operandLookAlikes.map((sample) => [sample.id, sample] as const))(
    "%s doesn't read as running what it fetched or decoded",
    (_id, sample) => {
      const rules = scanSample(sample).findings.map((finding) => finding.rule);
      expect(rules).not.toContain("download-exec");
      expect(rules).not.toContain("decode-exec");
    },
  );
});
