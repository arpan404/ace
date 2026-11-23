// SPDX-License-Identifier: Apache-2.0

/*
 * Builds `ace-core-wasm` for `fake-daemon` in the browser (ADR 0223, E0):
 * the `ace-core-wasm` crate to WebAssembly, then `wasm-bindgen` over it.
 * E4 serves the `@ace/core` facade over the result.
 *
 *   bun scripts/build-core-wasm.ts [--out <dir>]
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outIndex = process.argv.indexOf("--out");
const out =
  outIndex >= 0
    ? (process.argv[outIndex + 1] as string)
    : join(root, "native", "daemon", "wasm-pkg");
const target = "wasm32-unknown-unknown";

function cargo(args: string[]): void {
  try {
    execFileSync("rustup", ["--version"], { stdio: "ignore" });
    const toolchain = "1.95.0";
    execFileSync("rustup", ["run", toolchain, "cargo", ...args], {
      cwd: join(root, "native", "daemon"),
      stdio: "inherit",
    });
    return;
  } catch {
    execFileSync("cargo", args, { cwd: join(root, "native", "daemon"), stdio: "inherit" });
  }
}

cargo(["build", "--release", "--target", target, "-p", "ace-core-wasm"]);
const wasm = join(root, "native", "daemon", "target", target, "release", "ace_core_wasm.wasm");
if (!existsSync(wasm)) throw new Error(`expected ${wasm}`);
try {
  execFileSync("wasm-bindgen", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("wasm-bindgen CLI not found: install it with `cargo install wasm-bindgen-cli`");
}
execFileSync("wasm-bindgen", [wasm, "--out-dir", out, "--target", "web"], { stdio: "inherit" });
console.log(`wrote ${out}`);
