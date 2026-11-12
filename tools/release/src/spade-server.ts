import { execFile, execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseTarget as Target } from "@ace/protocol";
import { bundledSpadeServer, spadeServerFolder } from "@ace/service/spade-layout";
import { spadeBinaryName } from "@ace/service/spade-service";
import type { z } from "zod";

type ReleaseTarget = z.infer<typeof Target>;

/**
 * Spade's server ships in every release beside the daemon (ADR 0123), at `spade/spade-server`
 * (`.exe` on Windows) in the archive and in the desktop app's resources, so the signed
 * manifest and checksums cover it like everything else. `ACE_SPADE_SERVER_BIN` names a
 * prebuilt binary; otherwise cargo builds it from `spade/` in release mode. A build that can't
 * produce it fails. Whether a person sees Spade is decided at run time, by `features.json` in
 * ace's home (ADR 0139), never by the build.
 *
 * Spade reports the version stamped into it at build time (`ACE_SPADE_VERSION`) in `/health`,
 * `server.json` and `spade-server --version`, and the updater waits for exactly the release's
 * version after a swap. So cargo builds with the release's version, and a binary whose
 * `--version` says anything else is refused.
 */
export { spadeServerFolder };

const triples: Record<ReleaseTarget, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export type Cargo = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => void;
const systemCargo: Cargo = (args, cwd, env) => {
  execFileSync("cargo", [...args], { cwd, env, stdio: "inherit" });
};

/** What `<binary> --version` prints, trimmed. */
export type VersionOf = (binary: string) => Promise<string>;
const systemVersionOf: VersionOf = (binary) =>
  new Promise((resolve, reject) => {
    execFile(binary, ["--version"], { timeout: 30_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    );
  });

/** Where the staged binary goes under a release or desktop `root`. */
export const stagedSpadeServer = (root: string, target: ReleaseTarget) =>
  bundledSpadeServer(root, target.startsWith("win32") ? "win32" : "linux");

/**
 * Stages `spade-server` for `target` into `root/spade/`. Returns how it got there.
 */
export async function stageSpadeServer(options: {
  repo: string;
  root: string;
  target: ReleaseTarget;
  /** The release's version, which the binary must report. */
  version: string;
  env: NodeJS.ProcessEnv;
  cargo?: Cargo;
  versionOf?: VersionOf;
  /** This machine's target: a binary built for another one can't be run to ask its version. */
  host?: string;
}): Promise<"prebuilt" | "built"> {
  const { repo, root, target, env, version } = options;
  const host = options.host ?? `${process.platform}-${process.arch}`;
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
        { ...env, ACE_SPADE_VERSION: version },
      );
    } catch (error) {
      throw new Error(
        `Spade's server didn't build for ${target}. Install the Rust toolchain from spade/rust-toolchain.toml, or set ACE_SPADE_SERVER_BIN to a prebuilt binary.`,
        { cause: error },
      );
    }
    source = join(crate, "target", triple, "release", name);
    how = "built";
  }
  const info = await lstat(source).catch(() => undefined);
  if (!info?.isFile())
    throw new Error(`Spade's server is missing at ${source}: every release carries it.`);
  // A prebuilt binary is always asked; a built one when it runs here (cargo stamped it).
  if (how === "prebuilt" || host === target) {
    let reported: string;
    try {
      reported = await (options.versionOf ?? systemVersionOf)(source);
    } catch (error) {
      throw new Error(`Couldn't ask ${source} for its version`, { cause: error });
    }
    if (reported !== version)
      throw new Error(
        `${source} reports version ${JSON.stringify(reported.slice(0, 80))}, not this release's ${version}. Build it with ACE_SPADE_VERSION=${version}.`,
      );
  }
  await mkdir(join(root, spadeServerFolder), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  return how;
}
