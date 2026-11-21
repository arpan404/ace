// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ace-history, the daemon's saved-history reader (ADR 0206): its own Cargo workspace, lockfile
// and pinned toolchain, with native/files' checks and licence allowlist.
const cwd = new URL("../native/history/", import.meta.url);
const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(new URL("rust-toolchain.toml", cwd), "utf8"),
)?.[1];
if (channel === undefined) throw new Error("native/history/rust-toolchain.toml names no channel");
const pinned: string = channel;
const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasRustup)
  console.warn(
    "check:history: rustup not found, so running cargo from PATH, not the pinned toolchain",
  );

function cargo(args: string[]): void {
  // Clippy's lints change between releases: run the toolchain the workspace pins.
  if (hasRustup)
    execFileSync("rustup", ["run", pinned, "cargo", ...args], { cwd, stdio: "inherit" });
  else execFileSync("cargo", args, { cwd, stdio: "inherit" });
}

for (const args of [
  ["fmt", "--all", "--check"],
  ["clippy", "--workspace", "--all-targets", "--locked"],
  ["test", "--workspace", "--locked"],
  // The crash, race and import-mark tests need ace-history's test hooks.
  ["clippy", "--workspace", "--all-targets", "--locked", "--features", "ace-history/test-hooks"],
  ["test", "--workspace", "--locked", "--features", "ace-history/test-hooks"],
  ["deny", "check", "licenses", "sources"],
])
  cargo(args);
