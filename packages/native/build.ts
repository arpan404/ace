import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rustToolchain } from "./src/toolchain.ts";

/**
 * Builds ace's Rust add-on (ADR 0125) from `rust/` in release mode and installs it as
 * `dist/ace-native.node`. Always release: the daemon, the perf gate and development all run
 * the optimised build, so a measurement never describes a debug build.
 *
 * `ACE_NATIVE_PROFILE=dev` builds unoptimised for quick iteration on the Rust side only.
 * The copy goes through a temporary name and a rename, so a daemon restarting under
 * `bun --watch` never loads a half-written file.
 */
const repo = fileURLToPath(new URL("../..", import.meta.url));
const workspace = join(repo, "rust");
const profile = process.env.ACE_NATIVE_PROFILE === "dev" ? "dev" : "release";
const toolchain = rustToolchain(workspace, process.env);
execFileSync(toolchain.cargo, ["build", "--locked", "--profile", profile, "-p", "ace-node"], {
  cwd: workspace,
  env: toolchain.env,
  stdio: "inherit",
});
const library =
  process.platform === "win32"
    ? "ace_node.dll"
    : process.platform === "darwin"
      ? "libace_node.dylib"
      : "libace_node.so";
const built = join(workspace, "target", profile === "dev" ? "debug" : "release", library);
const dist = fileURLToPath(new URL("./dist", import.meta.url));
mkdirSync(dist, { recursive: true });
const staged = join(dist, `ace-native.node.${process.pid}.tmp`);
copyFileSync(built, staged);
// Drop local symbols, keeping the exported Node-API entry points (see rust/Cargo.toml).
if (profile === "release" && process.platform === "darwin")
  execFileSync("strip", ["-x", staged], { stdio: "inherit" });
if (profile === "release" && process.platform === "linux")
  execFileSync("strip", ["--strip-unneeded", staged], { stdio: "inherit" });
renameSync(staged, join(dist, "ace-native.node"));
