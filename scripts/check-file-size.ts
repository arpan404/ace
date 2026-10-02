import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Fails when a tracked source file exceeds the line limit in AGENTS.md. */
const LIMIT = 1500;
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.js", "*.mjs"], {
  encoding: "utf8",
})
  .split("\0")
  .filter((path) => path && !path.startsWith("fixtures/") && !path.includes("/__fixtures__/"));

const oversized = tracked
  .map((path) => ({ path, lines: readFileSync(path, "utf8").split("\n").length }))
  .filter(({ lines }) => lines > LIMIT)
  .toSorted((a, b) => b.lines - a.lines);

if (oversized.length > 0) {
  for (const { path, lines } of oversized) {
    process.stderr.write(`${path}: ${lines} lines (limit ${LIMIT}); split it by responsibility\n`);
  }
  process.exit(1);
}
process.stdout.write(`All ${tracked.length} source files are within ${LIMIT} lines.\n`);
