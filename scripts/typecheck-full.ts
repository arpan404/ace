import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceTypecheckConfigs } from "./typecheck-projects.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The compiler is tsc-rs, a Rust port of TypeScript 7; `typescript` still supplies the config API.
const tsc = fileURLToPath(new URL("./bin/tsc-rs", import.meta.resolve("tsc-rs/package.json")));
process.env.GOMAXPROCS = "2";
// Optional original config paths allow focused verification without a full-repo run.
const requested = process.argv.slice(2);
const configs = requested.length
  ? requested.map((file) => resolve(file))
  : sourceTypecheckConfigs(root);
const cache = join(root, ".cache/typecheck");
mkdirSync(cache, { recursive: true });
const temporary = mkdtempSync(join(cache, "full-"));
try {
  for (const [index, config] of configs.entries()) {
    const result = spawnSync(
      process.execPath,
      [
        tsc,
        "--project",
        config,
        "--noEmit",
        "--incremental",
        // A fresh build-info path prevents reuse of any previous diagnostic result.
        "--tsBuildInfoFile",
        join(temporary, `${index}.tsbuildinfo`),
        "--checkers",
        "1",
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
