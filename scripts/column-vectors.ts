// SPDX-License-Identifier: Apache-2.0
/*
 * Builds `native/daemon/vectors/columns.json` for phase 5.3b: every case first as JSON text,
 * then every column value, the change set and the cold row, exactly as the TypeScript encoders
 * give them. `crates/ace-projection/tests/column_vectors.rs` replays the texts in Rust.
 *
 *   bun scripts/column-vectors.ts [--check]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shapeCases } from "./column-vector-shapes.ts";
import { writeCases } from "./column-vector-writes.ts";
import { pristine, roots } from "./column-vector-support.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "native/daemon/vectors/columns.json");

// The samples must each parse to the same JSON text; otherwise the cases lie about the shapes.
for (const family of ["client", "details", "acp"] as const) {
  const sample = pristine()[family];
  if (JSON.stringify(roots[family].parse(sample)) !== JSON.stringify(sample))
    throw new Error(`fieldSamples.${family} does not parse to the same JSON text`);
}

const cases = [...shapeCases, ...writeCases];
// oxfmt writes the committed file (short arrays inline, as `fmt:check` expects); format the
// exact text in a scratch file so `--check` compares like for like.
const text = formatted(`${JSON.stringify(cases, null, 2)}\n`);

function formatted(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ace-columns-"));
  try {
    const path = join(dir, "columns.json");
    writeFileSync(path, source);
    execFileSync("bun", ["x", "oxfmt", path], { cwd: root, stdio: "ignore" });
    return readFileSync(path, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error(`vectors differ: ${out} (run without --check to regenerate)`);
    process.exit(1);
  }
  console.log(`column vectors ok: ${cases.length} cases`);
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${cases.length} cases`);
}
