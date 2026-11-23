// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The daemon's Rust core (ADR 0222): its own Cargo workspace, lockfile and pinned toolchain,
// with native/history's checks and licence allowlist. Its behaviour is proven by the store's
// TypeScript tests run with ACE_STORE=native, not by tests of its own. Since E0 the engine's
// generated protocol types are proven the same way: committed, and regenerated here, failing
// on any diff so `packages/protocol` stays the one source of truth (ADR 0223).

const root = fileURLToPath(new URL("../", import.meta.url));
execFileSync("bun", ["scripts/generate-rust-protocol.ts", "--check"], {
  cwd: root,
  stdio: "inherit",
});
const cwd = new URL("../native/daemon/", import.meta.url);
const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(new URL("rust-toolchain.toml", cwd), "utf8"),
)?.[1];
if (channel === undefined) throw new Error("native/daemon/rust-toolchain.toml names no channel");
const pinned: string = channel;
const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;

function cargo(args: string[]): void {
  if (hasRustup)
    execFileSync("rustup", ["run", pinned, "cargo", ...args], { cwd, stdio: "inherit" });
  else execFileSync("cargo", args, { cwd, stdio: "inherit" });
}

for (const args of [
  ["fmt", "--all", "--check"],
  ["clippy", "--workspace", "--all-targets", "--locked"],
  ["build", "--release", "--locked", "-p", "ace-daemon-node"],
  ["deny", "check", "licenses", "sources"],
])
  cargo(args);
