import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * The pinned toolchain for `rust/` (`rust/rust-toolchain.toml`). Build and check scripts run
 * this toolchain's cargo by absolute path with its tools first on PATH, so a cargo, rustc or
 * clippy earlier on PATH (Homebrew's, or another toolchain's bin directory) can't slip in.
 */
export interface RustToolchain {
  channel: string;
  cargo: string;
  env: NodeJS.ProcessEnv;
}

export function rustToolchain(workspace: string, env: NodeJS.ProcessEnv): RustToolchain {
  const channel = /^channel\s*=\s*"([^"]+)"/m.exec(
    readFileSync(join(workspace, "rust-toolchain.toml"), "utf8"),
  )?.[1];
  if (!channel) throw new Error(`${workspace}/rust-toolchain.toml names no channel`);
  const which = (tool: string) => {
    try {
      return execFileSync("rustup", ["which", "--toolchain", channel, tool], {
        encoding: "utf8",
        env,
      }).trim();
    } catch (error) {
      throw new Error(
        `Rust ${channel} is not installed: rustup toolchain install ${channel} ` +
          "--profile minimal -c clippy -c rustfmt",
        { cause: error },
      );
    }
  };
  const cargo = which("cargo");
  // cargo finds clippy, rustfmt and rustdoc on PATH, so the toolchain's own bin directory
  // goes first, and rustc and rustdoc are named outright.
  const path = [dirname(cargo), env.PATH ?? ""].join(delimiter);
  return {
    channel,
    cargo,
    env: { ...env, PATH: path, RUSTC: which("rustc"), RUSTDOC: which("rustdoc") },
  };
}
