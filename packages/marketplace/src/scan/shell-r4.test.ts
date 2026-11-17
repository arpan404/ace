import { describe, expect, it } from "vitest";
import { scanSample } from "./corpus.ts";
import {
  envResolved,
  executingLeafCaught,
  executingLeafHeld,
  safeLeaves,
} from "./corpus-r4-shell.ts";

/*
 * A "safe leaf" that can execute its arguments is not safe (ADR 0174 §8, fail closed). `sed 'e …'`,
 * `find -exec`, `awk 'system(…)'`, `tar --to-command`, `git -c <exec key>=…` and an editor's
 * startup command each run a command: the nested command is read back and caught when it is
 * literal, or the version is held. The same leaves with ordinary options stay clean.
 */

const result = (sample: Parameters<typeof scanSample>[0]) => {
  const report = scanSample(sample);
  return { verdict: report.verdict, rules: report.findings.map((finding) => finding.rule) };
};

describe("option-aware safe leaves", () => {
  it.each(executingLeafCaught.map((sample) => [sample.id, sample] as const))(
    "%s is caught as downloading and running code",
    (_id, sample) => {
      const { verdict, rules } = result(sample);
      expect(rules).toContain("download-exec");
      expect(verdict).toBe("block");
    },
  );

  it.each(executingLeafHeld.map((sample) => [sample.id, sample] as const))(
    "%s is held as a command the scanner can't prove safe",
    (_id, sample) => {
      const { verdict, rules } = result(sample);
      expect(rules).toContain("unreadable");
      expect(verdict).not.toBe("pass");
    },
  );

  it.each(envResolved.map((sample) => [sample.id, sample] as const))(
    "%s resolves to the command it runs or is held",
    (_id, sample) => {
      const { verdict, rules } = result(sample);
      // `env -S` is unwrapped to the interpreter it runs; either way it is never silently passed
      // as an opaque leaf that could execute.
      expect(verdict === "pass" || rules.includes("unreadable")).toBe(true);
    },
  );

  it.each(safeLeaves.map((sample) => [sample.id, sample] as const))(
    "%s stays clean",
    (_id, sample) => {
      const { verdict, rules } = result(sample);
      expect(rules).not.toContain("unreadable");
      expect(rules).not.toContain("download-exec");
      expect(verdict).toBe("pass");
    },
  );
});
