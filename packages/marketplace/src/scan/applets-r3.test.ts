import { describe, expect, it } from "vitest";
import { scanSample } from "./corpus.ts";
import { appletLookAlikes, appletSamples, unknownWrapperSamples } from "./corpus-r3-applets.ts";

/*
 * Multi-call applets read as the applet they run (`busybox sh x` is `sh x`), and a program the
 * reader can't resolve that is handed an interpreter or a script is held (ADR 0173 §8, fail
 * closed). Ordinary commands that only mention an interpreter stay clean.
 */

const rules = (id: string, sample: Parameters<typeof scanSample>[0]) => {
  const report = scanSample(sample);
  return { report, rules: report.findings.map((finding) => finding.rule), id };
};

describe("multi-call applets and unknown wrappers", () => {
  it.each(appletSamples.map((sample) => [sample.id, sample] as const))(
    "%s is refused as running a download or hidden code",
    (id, sample) => {
      const { report, rules: found } = rules(id, sample);
      expect(report.verdict).toBe("block");
      expect(found.some((rule) => rule === "download-exec" || rule === "decode-exec")).toBe(true);
    },
  );

  it.each(unknownWrapperSamples.map((sample) => [sample.id, sample] as const))(
    "%s is held as a command the scanner can't resolve",
    (id, sample) => {
      const { report, rules: found } = rules(id, sample);
      expect(found).toContain("unreadable");
      expect(report.verdict).not.toBe("pass");
    },
  );

  it.each(appletLookAlikes.map((sample) => [sample.id, sample] as const))(
    "%s stays clean",
    (_id, sample) => {
      const report = scanSample(sample);
      expect(report.findings).toEqual([]);
      expect(report.verdict).toBe("pass");
    },
  );
});
