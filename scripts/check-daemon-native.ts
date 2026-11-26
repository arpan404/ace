// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
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
execFileSync("bun", ["scripts/stored-command-vectors.ts", "--check"], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("bun", ["scripts/store-vectors.ts", "--check"], {
  cwd: root,
  stdio: "inherit",
});
// The column encoders' vectors (porting guide 5.3b): every fold pair plus the shape cases,
// with what SQLite's binder accepts.
execFileSync("bun", ["scripts/column-vectors.ts", "--check"], {
  cwd: root,
  stdio: "inherit",
});
// The transport's route table (ADR 0226): message types come from the protocol schemas, owners
// from `scripts/transport-owners.ts`. Committed and regenerated here, so a new message type
// can't reach the daemon without an owner.
execFileSync("bun", ["scripts/generate-transport-routes.ts", "--check"], {
  cwd: root,
  stdio: "inherit",
});
// The wire vectors T3 and T4a build: each is generated from the TypeScript it proves (the
// encoder, the trims, the subscriptions, command lanes and status, the stored-row decode).
// Regenerated and compared here, a TypeScript change that moves a byte fails this check instead
// of leaving Rust green on stale vectors.
const generators = [
  "crates/ace-fanout/vectors/make-vectors.ts",
  "crates/ace-fanout/vectors/make-trim-vectors.ts",
  "crates/ace-fanout/vectors/make-subscription-vectors.ts",
  "crates/ace-fanout/vectors/make-sidebar-vectors.ts",
  "crates/ace-fanout/vectors/make-command-vectors.ts",
  "crates/ace-store/vectors/make-stored-vectors.ts",
];
for (const generator of generators) {
  execFileSync("bun", [generator, "--check"], {
    cwd: fileURLToPath(new URL("../native/daemon/", import.meta.url)),
    stdio: "inherit",
  });
}
    cwd: fileURLToPath(new URL("../native/daemon/", import.meta.url)),
    stdio: "inherit",
  });
}
const cwd = new URL("../native/daemon/", import.meta.url);
const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(new URL("rust-toolchain.toml", cwd), "utf8"),
)?.[1];
if (channel === undefined) throw new Error("native/daemon/rust-toolchain.toml names no channel");
const pinned: string = channel;
const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasRustup)
  console.warn(
    "check:daemon-native: rustup not found, so running cargo from PATH, not the pinned toolchain",
  );

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

for (const args of [
  ["fmt", "--all", "--check"],
  ["clippy", "--workspace", "--all-targets", "--locked"],
  ["build", "--release", "--locked", "-p", "ace-daemon-node"],
  // The resolved workspace graph: licences and sources stay allowlisted, and
  // the bans (e.g. `uluru`, which would arrive with `gix`'s
  // `pack-cache-lru-static`) stay out.
  ["deny", "check", "bans", "licenses", "sources"],
])
  cargo(args);

// The MCP catalog (M1): every word, descriptor and header the TypeScript writes, compared with
// the committed files the Rust server embeds.
execFileSync("bun", ["scripts/export-catalog.ts", "--check"], { cwd: root, stdio: "inherit" });

// The device words are one catalog both backends read (ADR 0225 safeguard 3): render every
// key through the built Rust addon and compare it with the file.
execFileSync("bun", ["scripts/check-devices-catalog.ts"], { cwd: root, stdio: "inherit" });

// The core's wasm binding ships beside the addon: the `@ace/core` facade
// reads it under `ACE_CORE=wasm`, so this check builds it on the pinned
// toolchain (with its wasm32 target) rather than leaving a manual step.
execFileSync("bun", ["scripts/build-core-wasm.ts"], { cwd: root, stdio: "inherit" });
