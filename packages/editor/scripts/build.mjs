import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/*
 * Builds the editor's Wasm and its bindings into packages/editor/pkg.
 *
 * The Rust profile settings live on the command line because a crate cannot set `[profile.*]`
 * in a workspace: opt-level=s and LTO keep the editor small, and the crate is built only for
 * wasm32-unknown-unknown. `wasm-opt` is applied when it is installed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const workspace = join(root, "native", "editor");
const crate = join(workspace, "crates", "editor-wasm");
const out = join(here, "..", "pkg");
const compiled = join(workspace, "target", "wasm32-unknown-unknown", "release", "editor_wasm.wasm");

const pinned = /wasm-bindgen = "=([0-9.]+)"/.exec(
  readFileSync(join(crate, "Cargo.toml"), "utf8"),
)?.[1];
if (!pinned) {
  fail("editor-wasm's Cargo.toml does not pin wasm-bindgen.");
}
requireWasmBindgen(pinned);

run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "editor-wasm"], {
  cwd: workspace,
  env: {
    ...process.env,
    CARGO_PROFILE_RELEASE_OPT_LEVEL: "s",
    CARGO_PROFILE_RELEASE_LTO: "true",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
    CARGO_PROFILE_RELEASE_STRIP: "symbols",
  },
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("wasm-bindgen", ["--target", "web", "--out-dir", out, "--out-name", "editor_wasm", compiled]);

const wasmFile = join(out, "editor_wasm_bg.wasm");
optimise(wasmFile);

const bytes = statSync(wasmFile).size;
const gzipped = gzipSync(readFileSync(wasmFile)).length;
process.stdout.write(`editor wasm: ${kib(bytes)} KiB (${bytes} bytes), gzip ${kib(gzipped)} KiB\n`);

function kib(value) {
  return (value / 1024).toFixed(1);
}

/** The bindings must come from the CLI version the crate was built against. */
function requireWasmBindgen(version) {
  const probe = spawnSync("wasm-bindgen", ["--version"], { encoding: "utf8" });
  const install = `cargo install wasm-bindgen-cli --version ${version}`;
  if (probe.error) {
    fail(`wasm-bindgen is missing. Install the matching CLI first: ${install}`);
  }
  const found = probe.stdout.trim().split(/\s+/)[1];
  if (found !== version) {
    fail(`wasm-bindgen ${found ?? "unknown"} does not match the crate's ${version}: ${install}`);
  }
}

/** wasm-opt when binaryen is installed; the build stays valid without it. */
function optimise(file) {
  if (!existsSync(file)) {
    fail(`wasm-bindgen wrote no ${file}`);
  }
  const probe = spawnSync("wasm-opt", ["--version"], { encoding: "utf8" });
  if (probe.error) {
    process.stdout.write("wasm-opt not installed: skipping the size pass.\n");
    return;
  }
  const optimised = `${file}.opt`;
  run("wasm-opt", ["-Os", file, "-o", optimised]);
  renameSync(optimised, file);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    fail(`${command} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with ${result.status}`);
  }
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
