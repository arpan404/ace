import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/*
 * Keeps Zod schemas from being built inside functions in daemon and package code. Zod 4
 * compiles a parser for every new object schema, so a schema built per call is rebuilt and
 * recompiled per event, row or request; a live profile showed it as the daemon's largest
 * allocation cost. Build schemas once, at module level.
 *
 * The rule itself is `ace/zod-schema-in-function` (scripts/oxlint/ace-plugin.js). This script
 * runs it and ratchets against `scripts/zod-schema-baseline.json`: a file may keep the count it
 * has and never gain one, and a file not listed may have none. Code that runs once (startup,
 * migrations, a CLI command, tool registration) can instead say why on the line before:
 * `// oxlint-disable-next-line ace/zod-schema-in-function -- <why it runs once>`.
 * `--update` rewrites the baseline from the tree, so fixing files tightens it.
 *
 * It fails closed: oxlint must run, load the plugin and report exactly the expected cases in
 * `scripts/oxlint/zod-rule-cases.ts`, and every line it prints must be understood, before any
 * count is trusted or the baseline is written.
 */

const baselinePath = "scripts/zod-schema-baseline.json";
const casesPath = "scripts/oxlint/zod-rule-cases.ts";
const roots = ["apps/daemon/src", "packages"];
// Tests, test support and benchmarks run outside the daemon; their schemas cost nothing live.
const exempt =
  /\.test\.tsx?$|test-support|[-/]testing\/|\/testing\.ts$|\/fixtures?\/|\.fixture\.ts$|\/bench\/|\/evals\/|test-process|\/conformance\//;
const diagnostic = /^(.+?):(\d+):\d+: .*\[Error\/ace\(zod-schema-in-function\)\]$/;
const summary = /^(\d+) problems?$/;

function fail(reason: string, detail = ""): never {
  console.error(`check-zod-schemas: ${reason}${detail ? `\n${detail}` : ""}`);
  process.exit(1);
}

const run = spawnSync(
  "oxlint",
  ["-c", "scripts/oxlint/zod-schemas.json", "--format", "unix", casesPath, ...roots],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const report = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
if (run.error) fail(`could not run oxlint: ${run.error.message}`);
// 1 is "found problems", which the cases file guarantees; anything else is oxlint failing.
if (run.status !== 1) fail(`oxlint exited with ${run.status ?? run.signal}`, report);

const counts: Record<string, number> = {};
const caseLines: number[] = [];
let reported = 0;
let total: number | undefined;
for (const line of run.stdout.split("\n")) {
  if (!line.trim()) continue;
  const problems = summary.exec(line);
  if (problems) {
    total = Number(problems[1]);
    continue;
  }
  const match = diagnostic.exec(line);
  // A config or plugin load failure, another rule's report or a new output format.
  if (!match?.[1] || !match[2]) fail(`unrecognised oxlint output: ${line}`, report);
  reported++;
  const path = match[1];
  if (path === casesPath) caseLines.push(Number(match[2]));
  else if (!exempt.test(path)) counts[path] = (counts[path] ?? 0) + 1;
}
if (total !== reported) fail(`oxlint reported ${reported} lines but counted ${total}`, report);

const expected = readFileSync(casesPath, "utf8")
  .split("\n")
  .flatMap((text, index) => (text.trimEnd().endsWith("// flagged") ? [index + 1] : []));
if (caseLines.toSorted((a, b) => a - b).join() !== expected.join())
  fail(
    `the rule no longer reports exactly the cases in ${casesPath}`,
    `expected lines ${expected.join(", ")}; reported ${caseLines.join(", ") || "none"}`,
  );

if (process.argv.includes("--update")) {
  const sorted = Object.fromEntries(
    Object.entries(counts).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${baselinePath}: ${Object.keys(sorted).length} files`);
  process.exit(0);
}

const baseline: Record<string, number> = JSON.parse(readFileSync(baselinePath, "utf8"));
const grown = Object.entries(counts).filter(([path, count]) => count > (baseline[path] ?? 0));
for (const [path, count] of grown)
  console.error(
    `${path}: ${count} Zod schema(s) built inside functions (baseline ${baseline[path] ?? 0}). ` +
      "Hoist them to module-level constants; see scripts/check-zod-schemas.ts.",
  );
if (grown.length) process.exit(1);
const shrunk = Object.entries(baseline).filter(([path, count]) => (counts[path] ?? 0) < count);
if (shrunk.length)
  console.log(
    `${shrunk.length} file(s) are under their Zod schema baseline; run \`node scripts/check-zod-schemas.ts --update\` to lock that in.`,
  );
