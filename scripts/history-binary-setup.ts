import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** The ace-history the process tests run, built with its test hooks (ADR 0206). */
    historyBinary: string;
  }
}

const workspace = fileURLToPath(new URL("../native/history/", import.meta.url));
// Its own target directory: the hooks build never replaces a debug or release build.
const target = `${workspace}target/test-hooks`;

/**
 * Build ace-history with its `test-hooks` feature before any process test reads saved history,
 * and fail the run, loudly, when it cannot be built: a history test must never pass by skipping
 * the reader it tests. Cargo's own freshness check makes this a no-op when nothing changed.
 */
export default function setup(project: TestProject) {
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
    readFileSync(`${workspace}rust-toolchain.toml`, "utf8"),
  )?.[1];
  const rustup = spawnSync("rustup", ["--version"], { stdio: "ignore" }).status === 0;
  const args = [
    "build",
    "--locked",
    "-p",
    "ace-history",
    "--features",
    "test-hooks",
    "--target-dir",
    target,
  ];
  try {
    if (rustup && channel)
      execFileSync("rustup", ["run", channel, "cargo", ...args], {
        cwd: workspace,
        stdio: "inherit",
      });
    else execFileSync("cargo", args, { cwd: workspace, stdio: "inherit" });
  } catch (error) {
    throw new Error(
      `The history process tests need ace-history, and it did not build (${String(error)}). Install rustup and the toolchain native/history pins.`,
    );
  }
  const binary = `${target}/debug/${process.platform === "win32" ? "ace-history.exe" : "ace-history"}`;
  if (!existsSync(binary)) throw new Error(`ace-history built, but ${binary} is missing`);
  project.provide("historyBinary", binary);
}
