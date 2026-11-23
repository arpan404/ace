// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
  // Clippy's lints change between releases: run the toolchain the workspace pins. Its bin dir
  // goes first on PATH and its own cargo binary is preferred: `rustup run` resolves through
  // PATH on some setups (Homebrew rustup), and cargo finds its subcommands (`cargo-clippy`,
  // `cargo-fmt`) on PATH, so either can pick another toolchain's binaries and lints.
  const bin = pinnedToolchainBin();
  const env = {
    ...process.env,
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
    ...(bin === undefined ? {} : { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }),
  };
  const command =
    bin === undefined ? null : join(bin, `cargo${process.platform === "win32" ? ".exe" : ""}`);
  if (command !== null && existsSync(command))
    execFileSync(command, args, { cwd, env, stdio: "inherit" });
  else if (hasRustup)
    execFileSync("rustup", ["run", pinned, "cargo", ...args], { cwd, env, stdio: "inherit" });
  else execFileSync("cargo", args, { cwd, env, stdio: "inherit" });
}

/** The pinned toolchain's bin dir when it is installed, else undefined. */
function pinnedToolchainBin(): string | undefined {
  try {
    const home = process.env.RUSTUP_HOME ?? join(homedir(), ".rustup");
    const toolchain = readdirSync(join(home, "toolchains")).find((name) =>
      name.startsWith(`${pinned}-`),
    );
    const bin = toolchain === undefined ? undefined : join(home, "toolchains", toolchain, "bin");
    if (bin !== undefined && existsSync(join(bin, "cargo"))) return bin;
  } catch {
    // No toolchain dir to read: fall through below.
  }
  return undefined;
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
