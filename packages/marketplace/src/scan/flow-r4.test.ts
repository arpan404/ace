import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import type { CorpusSample } from "./corpus-malicious.ts";
import { flowR4Benign, flowR4Corpus } from "./corpus-r4-flow.ts";
import { analyse } from "./dataflow.ts";
import { parseJs, walk } from "./js-ast.ts";
import { scanEntry, type ScanContext } from "./index.ts";
import { viewOf } from "./script-view.ts";

/*
 * The data-flow rule inverted (ADR 0174 §8): beside a network or program sink, a read the scanner
 * can't prove harmless is held, whatever runtime or spelling it uses, and the whole environment
 * reaching the network is blocked. A cap that drops code blocks as `scan-truncated`.
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
const flowOf = (report: ReturnType<typeof scanned>) =>
  report.findings.filter((finding) => finding.rule.startsWith("sensitive-exfil"));

describe("sources the scanner can't prove harmless, beside a sink", () => {
  it.each(flowR4Corpus.map((sample) => [sample.id, sample] as const))(
    "%s is caught",
    (_id, sample) => {
      const report = scanned(sample);
      const flow = flowOf(report);
      if (sample.expect === "block") {
        expect(report.verdict).toBe("block");
        expect(flow.map((finding) => finding.level)).toContain("block");
      } else {
        expect(report.verdict).not.toBe("pass");
        expect(flow.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(flowR4Benign.map((sample) => [sample.id, sample] as const))(
    "%s stays a pass",
    (_id, sample) => {
      const report = scanned(sample);
      expect(report.verdict).toBe("pass");
      expect(flowOf(report)).toEqual([]);
    },
  );

  it("holds one named environment value sent in a header, never blocks it", () => {
    const sample = flowR4Benign[0];
    if (!sample) throw new Error("the benign corpus has a sample");
    const report = scanned({
      ...sample,
      files: {
        "SKILL.md": "---\nname: header\ndescription: Does a small chore.\n---\n# header\n",
        "scripts/header.mjs":
          'const key = process.env.API_KEY;\nawait fetch("https://api.example.invalid/v1", { headers: { authorization: key } });\n',
      },
    });
    expect(report.verdict).not.toBe("block");
    expect(flowOf(report).map((finding) => finding.level)).toEqual(["warn"]);
  });
});

describe("a cap that drops code", () => {
  it("blocks a JavaScript file the walk cut short as scan-truncated", () => {
    const view = viewOf(
      "scripts/big.mjs",
      'const level = "info";\nawait fetch("https://api.example.invalid/status");\n',
    );
    const parsed = parseJs(view.text, { typescript: false });
    if (!parsed) throw new Error("the sample parses");
    let budget = 0;
    const capped: typeof walk = (root, visit) =>
      walk(root, (node, parent) => {
        if (++budget <= 3) visit(node, parent);
      }) && budget <= 3;
    const hits = analyse(view, parsed.program, false, false, capped);
    expect(hits).toContainEqual(expect.objectContaining({ level: "block", truncated: true }));
  });

  it("blocks a shell script with a line too long to read whole", () => {
    const report = scanned({
      id: "r4-long-line",
      category: "truncation",
      type: "spade-skill",
      name: "long-line",
      files: {
        "SKILL.md": "---\nname: long-line\ndescription: Does a small chore.\n---\n# long-line\n",
        "scripts/run.sh": `#!/bin/sh\necho ${"a".repeat(20_010)}\n`,
      },
      expect: "block",
    });
    expect(report.verdict).toBe("block");
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: "scan-truncated", level: "block", path: "scripts/run.sh" }),
    );
  });
});
