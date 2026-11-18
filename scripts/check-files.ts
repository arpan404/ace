// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The two Rust workspaces behind the Rust files work: the daemon's file system process and the
// editor core compiled to Wasm. Each has its own Cargo.lock and its own pinned toolchain.
const workspaces = ["../native/files/", "../native/editor/"];

const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasRustup) {
  const version = spawnSync("cargo", ["--version"], { encoding: "utf8" }).stdout?.trim();
  console.warn(
    `check:files: rustup not found, so running ${version || "cargo"}, not the pinned toolchain`,
  );
}

for (const workspace of workspaces) {
  const cwd = new URL(workspace, import.meta.url);
  // Clippy's lints change between Rust releases, so cargo runs on the toolchain the workspace
  // pins, not whichever cargo comes first on PATH (Homebrew's, say).
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
    readFileSync(new URL("rust-toolchain.toml", cwd), "utf8"),
  )?.[1];
  if (channel === undefined) throw new Error(`${workspace}rust-toolchain.toml names no channel`);
  const pinned: string = channel;
  function cargo(args: string[]): void {
    if (hasRustup)
      execFileSync("rustup", ["run", pinned, "cargo", ...args], { cwd, stdio: "inherit" });
    else execFileSync("cargo", args, { cwd, stdio: "inherit" });
  }

  for (const args of [
    ["fmt", "--all", "--check"],
    ["clippy", "--workspace", "--all-targets", "--locked"],
    ["test", "--workspace", "--locked"],
    ["deny", "check", "licenses", "sources"],
  ]) {
    cargo(args);
  }
}
