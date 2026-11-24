import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Fails when a tracked source file exceeds the line limit in AGENTS.md. */
const LIMIT = 1500;

/**
 * Generated files, which are rewritten wholesale and so can't be split the way
 * hand-written source can (the same reason `routeTree.gen.ts` is skipped below).
 */
// `scripts/generate-rust-protocol.ts` (typify) writes the whole wire schema here.
const GENERATED_FILES = new Set(["native/daemon/crates/ace-protocol/src/generated.rs"]);
// The same generator writes the shape table for the column encoders into this folder.
const GENERATED_DIRS = ["native/daemon/crates/ace-protocol/src/shapes/"];

const isGenerated = (path: string): boolean =>
  GENERATED_FILES.has(path) || GENERATED_DIRS.some((dir) => path.startsWith(dir));

const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.js", "*.mjs", "*.rs"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter((path) => path)
  // Rust source lives under native/ and spade/ only.
  .filter(
    (path) => !path.endsWith(".rs") || path.startsWith("native/") || path.startsWith("spade/"),
  )
  // A build output is never a source file, whether it was checked in or not.
  .filter((path) => !path.split("/").includes("target"))
  .filter((path) => !path.startsWith("fixtures/") && !path.includes("/__fixtures__/"))
  .filter((path) => !isGenerated(path))
  // A shipped Suit's scene is one script by format (ADR 0150: the scene page loads exactly one
  // file per region), so it can't be split into modules the way source can.
  .filter((path) => !/^packages\/plugins\/builtin-suits\/[^/]+\/[A-Za-z0-9-]+\.js$/.test(path))
  // The router writes its route tree from the routes folder; nobody edits it, so it isn't split.
  .filter((path) => !path.endsWith("/routeTree.gen.ts"));

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
