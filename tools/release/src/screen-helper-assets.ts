import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The Linux screen helper's file name, wherever it is staged. */
export const linuxScreenHelperName = "ace-screen-helper-linux";

/**
 * Where a daemon release keeps the Linux screen helper, relative to the directory holding the
 * daemon entry bundle (`ace.mjs`): the daemon looks for it there when no path is configured.
 */
export const linuxScreenHelperPath = join("helpers", linuxScreenHelperName);

const triples = { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" } as const;

/**
 * Builds `native/screen-helper-linux` for this host (release builds run in the Debian 12
 * container, so it needs glibc 2.36) and copies the executable to `destination`.
 */
export async function stageLinuxScreenHelper(repo: string, destination: string): Promise<void> {
  if (process.platform !== "linux" || (process.arch !== "arm64" && process.arch !== "x64"))
    throw new Error("Build the Linux screen helper on a Linux arm64 or x64 host");
  const crate = join(repo, "native/screen-helper-linux");
  const required = crateRustVersion(await readFile(join(crate, "Cargo.toml"), "utf8"));
  checkRustToolchain(required, installedRustc(crate));
  execFileSync("sh", [join(crate, "build.sh")], { stdio: "inherit" });
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(
    join(crate, "build", `${linuxScreenHelperName}-${triples[process.arch]}`),
    destination,
  );
  await chmod(destination, 0o755);
}

/** Why the Rust toolchain can't build the Linux screen helper. */
export class RustToolchainError extends Error {
  readonly reason: "missing" | "too-old";
  constructor(reason: "missing" | "too-old", message: string) {
    super(message);
    this.name = "RustToolchainError";
    this.reason = reason;
  }
}

/** The crate's `rust-version` (the oldest rustc that builds it), from its Cargo.toml. */
export function crateRustVersion(cargoToml: string): string {
  const version = /^rust-version\s*=\s*"(\d+\.\d+(?:\.\d+)?)"/m.exec(cargoToml)?.[1];
  if (!version) throw new Error("native/screen-helper-linux/Cargo.toml has no rust-version");
  return version;
}

/** `rustc --version` as cargo would run it in `crate`, or undefined when there is no rustc. */
function installedRustc(crate: string): string | undefined {
  try {
    return execFileSync("rustc", ["--version"], { cwd: crate, encoding: "utf8" });
  } catch {
    return undefined;
  }
}

/**
 * Throws a `RustToolchainError` naming what to install when `rustc --version` (`installed`) is
 * missing or older than `required`. Cargo would refuse an old one too, but only after the build
 * output has scrolled past, as one line among many.
 */
export function checkRustToolchain(required: string, installed: string | undefined): void {
  const fix = `The Linux screen helper (native/screen-helper-linux) needs Rust ${required} or newer`;
  if (installed === undefined)
    throw new RustToolchainError(
      "missing",
      `${fix}, and no rustc is on PATH. Install it from https://rustup.rs.`,
    );
  const found = /^rustc (\d+)\.(\d+)\.(\d+)/.exec(installed.trim());
  if (!found)
    throw new RustToolchainError(
      "missing",
      `${fix}; could not read \`rustc --version\`: ${installed}`,
    );
  const [major = 0, minor = 0, patch = 0] = required.split(".").map(Number);
  const have = found.slice(1).map(Number) as [number, number, number];
  const older =
    have[0] !== major ? have[0] < major : have[1] !== minor ? have[1] < minor : have[2] < patch;
  if (older)
    throw new RustToolchainError(
      "too-old",
      `${fix}; this machine has rustc ${have.join(".")}. Run \`rustup update stable\` (or install a newer Rust), then build again.`,
    );
}
