// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The Rust `ace` CLI (ADR 0221): its own Cargo workspace, lockfile and pinned toolchain, with
// native/history's checks. The command table is generated from the TypeScript CLI, so a stale
// copy fails before the Rust checks mean anything; the native-command unit test fails when a
// dispatched id leaves the table; and the CLI process tests run against the binary, so its
// grammar, output and hand-over are held to the same file as the TypeScript implementation.
const cwd = fileURLToPath(new URL("../native/cli/", import.meta.url));
const repo = fileURLToPath(new URL("../", import.meta.url));
const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(cwd, "rust-toolchain.toml"), "utf8"),
)?.[1];
if (channel === undefined) throw new Error("native/cli/rust-toolchain.toml names no channel");
const pinned: string = channel;
const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasRustup)
  console.warn("check:cli: rustup not found, so running cargo from PATH, not the pinned toolchain");

function cargo(args: string[]): void {
  const env = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4" };
  // Clippy's lints change between releases: run the toolchain the workspace pins.
  if (hasRustup)
    execFileSync("rustup", ["run", pinned, "cargo", ...args], { cwd, env, stdio: "inherit" });
  else execFileSync("cargo", args, { cwd, env, stdio: "inherit" });
}

execFileSync("bun", ["scripts/cli-table.ts", "--check"], { cwd: repo, stdio: "inherit" });

for (const args of [
  ["fmt", "--all", "--check"],
  ["clippy", "--workspace", "--all-targets", "--locked"],
  ["test", "--workspace", "--locked"],
  ["deny", "check", "licenses", "sources"],
])
  cargo(args);

// The process tests spawn the binary as it ships today, through the same helper switch a person
// would use. A debug build is enough for behaviour and much faster than a release one.
cargo(["build", "--locked", "-p", "ace-cli"]);
for (const file of [
  "apps/daemon/src/cli/grammar.process.test.ts",
  "apps/daemon/src/cli/agent-shell.process.test.ts",
])
  execFileSync("bun", ["--bun", "x", "vitest", "run", file, "--maxWorkers=4"], {
    cwd: repo,
    env: {
      ...process.env,
      ACE_CLI_IMPL: "rust",
      ACE_CLI_BIN: join(cwd, "target/debug/ace"),
    },
    stdio: "inherit",
  });
