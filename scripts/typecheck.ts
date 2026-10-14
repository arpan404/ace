import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { cleanTypecheck, prepareTypecheck } from "./typecheck-projects.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The compiler is tsc-rs, a Rust port of TypeScript 7; `typescript` still supplies the config API.
const tsc = fileURLToPath(new URL("./bin/tsc-rs", import.meta.resolve("tsc-rs/package.json")));
// The Go config API inherits this CPU limit; tsc-rs is bounded by --builders and --checkers.
process.env.GOMAXPROCS = "2";
const selected = process.argv[2] === "--workspace" ? process.cwd() : undefined;
const clean = process.argv[2] === "--clean";
if (process.argv.length > (selected || clean ? 3 : 2))
  throw new Error("Usage: typecheck.ts [--workspace | --clean]");
if (clean) {
  cleanTypecheck(root);
  process.exit(0);
}
const solutions = prepareTypecheck(root, selected);
for (const solution of [solutions.declarations, solutions.checks]) {
  const result = spawnSync(
    process.execPath,
    [tsc, "--build", solution, "--builders", "2", "--checkers", "1"],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
