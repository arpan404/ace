import { execFileSync } from "node:child_process";
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
 */

const baselinePath = "scripts/zod-schema-baseline.json";
const roots = ["apps/daemon/src", "packages"];
// Tests, test support and benchmarks run outside the daemon; their schemas cost nothing live.
const exempt =
  /\.test\.tsx?$|test-support|[-/]testing\/|\/testing\.ts$|\/fixtures?\/|\.fixture\.ts$|\/bench\/|\/evals\/|test-process|\/conformance\//;

let output = "";
try {
  output = execFileSync(
    "oxlint",
    ["-c", "scripts/oxlint/zod-schemas.json", "--format", "unix", ...roots],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch (error) {
  // oxlint exits non-zero when it reports anything; its report is still on stdout.
  const stdout = error instanceof Error && "stdout" in error ? error.stdout : undefined;
  if (typeof stdout !== "string") throw error;
  output = stdout;
}

const counts: Record<string, number> = {};
for (const line of output.split("\n")) {
  const match = /^(.+?):\d+:\d+: .*\[Error\/ace\(zod-schema-in-function\)\]$/.exec(line);
  const path = match?.[1];
  if (!path || exempt.test(path)) continue;
  counts[path] = (counts[path] ?? 0) + 1;
}

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
