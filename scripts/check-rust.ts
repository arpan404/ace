import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { rustToolchain } from "@ace/native/toolchain";

/**
 * `bun run check:rust`: the gate for ace's in-process Rust (`rust/`, ADR 0125). Every step
 * must pass; nothing here is advisory.
 *
 * 1. rustfmt, on the pinned toolchain.
 * 2. clippy on every target with every warning an error (the lint set is in rust/Cargo.toml).
 * 3. cargo test.
 * 4. cargo-deny: advisories, licences, duplicate versions and sources (rust/deny.toml).
 * 5. Unsafe code: every crate but `ace-node` starts with `#![forbid(unsafe_code)]`, and
 *    `ace-node` contains no hand-written `unsafe` (napi's macros are the only unsafe there).
 * 6. File size: no `.rs` file over 1,500 lines, as for TypeScript.
 */
const repo = resolve(import.meta.dirname, "..");
const workspace = join(repo, "rust");
const toolchain = rustToolchain(workspace, process.env);
const cargo = (args: string[]) =>
  execFileSync(toolchain.cargo, args, { cwd: workspace, env: toolchain.env, stdio: "inherit" });

cargo(["fmt", "--all", "--check"]);
cargo(["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"]);
cargo(["test", "--workspace", "--locked"]);
try {
  execFileSync("cargo-deny", ["check"], { cwd: workspace, stdio: "inherit" });
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    throw new Error("cargo-deny is not installed: cargo install cargo-deny --locked", {
      cause: error,
    });
  throw error;
}

function rustFiles(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) return name === "target" ? [] : rustFiles(path);
    return name.endsWith(".rs") ? [path] : [];
  });
}
const problems: string[] = [];
const crates = join(workspace, "crates");
for (const crate of readdirSync(crates)) {
  const files = rustFiles(join(crates, crate));
  if (crate === "ace-node") {
    for (const file of files)
      if (/\bunsafe\b/.test(readFileSync(file, "utf8")))
        problems.push(`${relative(repo, file)}: hand-written unsafe in the binding crate`);
    continue;
  }
  const lib = join(crates, crate, "src/lib.rs");
  if (!/^#!\[forbid\(unsafe_code\)\]$/m.test(readFileSync(lib, "utf8")))
    problems.push(`${relative(repo, lib)}: missing #![forbid(unsafe_code)]`);
}
for (const file of rustFiles(crates)) {
  const lines = readFileSync(file, "utf8").split("\n").length;
  if (lines > 1500) problems.push(`${relative(repo, file)}: ${lines} lines (limit 1,500)`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("check:rust passed");
