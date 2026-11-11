import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseTarget as Target } from "@ace/protocol";
import { spadeBinaryName } from "@ace/service/spade";
import type { z } from "zod";

type ReleaseTarget = z.infer<typeof Target>;

/**
 * Spade's server ships in every release beside the daemon (ADR 0123), at `spade/spade-server`
 * (`.exe` on Windows) in the archive and in the desktop app's resources, so the signed
 * manifest and checksums cover it like everything else. `ACE_SPADE_SERVER_BIN` names a
 * prebuilt binary; otherwise cargo builds it from `spade/` in release mode. A build that can't
 * produce it fails, unless `DISABLE_SPADE=1` leaves Spade out on purpose.
 */
export const spadeServerFolder = "spade";

const triples: Record<ReleaseTarget, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export type Cargo = (args: readonly string[], cwd: string) => void;
const systemCargo: Cargo = (args, cwd) => {
  execFileSync("cargo", [...args], { cwd, stdio: "inherit" });
};

/** Where the staged binary goes under a release or desktop `root`. */
export const stagedSpadeServer = (root: string, target: ReleaseTarget) =>
  join(root, spadeServerFolder, spadeBinaryName(target.startsWith("win32") ? "win32" : "linux"));

/**
 * Stages `spade-server` for `target` into `root/spade/`. Returns how it got there, or
 * `disabled` when `DISABLE_SPADE=1` left it out.
 */
export async function stageSpadeServer(options: {
  repo: string;
  root: string;
  target: ReleaseTarget;
  env: NodeJS.ProcessEnv;
  cargo?: Cargo;
}): Promise<"prebuilt" | "built" | "disabled"> {
  const { repo, root, target, env } = options;
  if (env.DISABLE_SPADE === "1") return "disabled";
  const destination = stagedSpadeServer(root, target);
  const name = spadeBinaryName(target.startsWith("win32") ? "win32" : "linux");
  let source: string;
  let how: "prebuilt" | "built" = "prebuilt";
  if (env.ACE_SPADE_SERVER_BIN) source = env.ACE_SPADE_SERVER_BIN;
  else {
    const triple = triples[target];
    const crate = join(repo, "spade");
    try {
      (options.cargo ?? systemCargo)(
        ["build", "--locked", "--release", "-p", "spade-server", "--target", triple],
        crate,
      );
    } catch (error) {
      throw new Error(
        `Spade's server didn't build for ${target}. Install the Rust toolchain from spade/rust-toolchain.toml, set ACE_SPADE_SERVER_BIN to a prebuilt binary, or set DISABLE_SPADE=1 to release without Spade.`,
        { cause: error },
      );
    }
    source = join(crate, "target", triple, "release", name);
    how = "built";
  }
  const info = await lstat(source).catch(() => undefined);
  if (!info?.isFile())
    throw new Error(
      `Spade's server is missing at ${source}: a release without it needs DISABLE_SPADE=1.`,
    );
  await mkdir(join(root, spadeServerFolder), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  return how;
}
