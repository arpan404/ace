// SPDX-License-Identifier: Apache-2.0

/*
 * Builds `ace-core-wasm` for `fake-daemon` in the browser (ADR 0223, E0):
 * the `ace-core-wasm` crate to WebAssembly, then `wasm-bindgen` over it.
 * E4 serves the `@ace/core` facade over the result.
 *
 *   bun scripts/build-core-wasm.ts [--out <dir> [--target <web|nodejs>]]
 *
 * Without `--out` both loaders the facade reads are built: `wasm-pkg`
 * (`--target web`, the browser) and `wasm-pkg-nodejs` (`--target nodejs`,
 * Node under `ACE_CORE=wasm`). With `--out` one bundle is built there
 * (web unless `--target nodejs` says otherwise), for one-off checks.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const daemon = join(root, "native", "daemon");
const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
  readFileSync(join(daemon, "rust-toolchain.toml"), "utf8"),
)?.[1];
if (channel === undefined) throw new Error("native/daemon/rust-toolchain.toml names no channel");
const pinned: string = channel;
const hasRustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
if (!hasRustup)
  console.warn(
    "build-core-wasm: rustup not found, so running cargo from PATH, not the pinned toolchain",
  );

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

function cargo(args: string[]): void {
  // Same pinned-toolchain preference as check:cli: the toolchain's bin dir
  // goes first on PATH and its own cargo binary is preferred.
  const bin = pinnedToolchainBin();
  const env = {
    ...process.env,
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4",
    ...(bin === undefined ? {} : { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }),
  };
  const command =
    bin === undefined ? null : join(bin, `cargo${process.platform === "win32" ? ".exe" : ""}`);
  if (command !== null && existsSync(command))
    execFileSync(command, args, { cwd: daemon, env, stdio: "inherit" });
  else if (hasRustup)
    execFileSync("rustup", ["run", pinned, "cargo", ...args], {
      cwd: daemon,
      env,
      stdio: "inherit",
    });
  else execFileSync("cargo", args, { cwd: daemon, env, stdio: "inherit" });
}

/** Ensure the wasm32 target is installed for the pinned toolchain. */
function ensureWasmTarget(): void {
  if (!hasRustup) return;
  execFileSync("rustup", ["target", "add", "wasm32-unknown-unknown", "--toolchain", pinned], {
    stdio: "inherit",
  });
}

const target = "wasm32-unknown-unknown";

function build(out: string, bindgenTarget: "web" | "nodejs"): void {
  cargo(["build", "--release", "--target", target, "-p", "ace-core-wasm"]);
  const wasm = join(daemon, "target", target, "release", "ace_core_wasm.wasm");
  if (!existsSync(wasm)) throw new Error(`expected ${wasm}`);
  try {
    execFileSync("wasm-bindgen", ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error("wasm-bindgen CLI not found: install it with `cargo install wasm-bindgen-cli`");
  }
  execFileSync("wasm-bindgen", [wasm, "--out-dir", out, "--target", bindgenTarget], {
    stdio: "inherit",
  });
  if (bindgenTarget === "nodejs") {
    // The nodejs output is CommonJS (`exports.*`); the repo is
    // `"type": "module"`, so mark this dir CommonJS or Node treats the
    // `.js` as ESM and `exports` is undefined under `ACE_CORE=wasm`.
    writeFileSync(join(out, "package.json"), `{"type":"commonjs"}\n`);
  }
  console.log(`wrote ${out} (${bindgenTarget})`);
}

ensureWasmTarget();

const outIndex = process.argv.indexOf("--out");
const targetIndex = process.argv.indexOf("--target");
const bindgenTarget = targetIndex >= 0 ? (process.argv[targetIndex + 1] as string) : undefined;
if (bindgenTarget !== undefined && bindgenTarget !== "web" && bindgenTarget !== "nodejs")
  throw new Error("--target takes web or nodejs");
if (outIndex >= 0) {
  const out = process.argv[outIndex + 1] as string;
  build(out, bindgenTarget === "nodejs" ? "nodejs" : "web");
} else {
  build(join(root, "native", "daemon", "wasm-pkg"), "web");
  build(join(root, "native", "daemon", "wasm-pkg-nodejs"), "nodejs");
}
