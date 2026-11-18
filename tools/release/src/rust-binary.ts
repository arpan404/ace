import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { assertLinuxRuntimeFloor } from "./glibc.ts";

export type Target = z.infer<typeof ReleaseTarget>;

/** The triple each native workspace is built for; cargo builds into `target/<triple>/<profile>`. */
export const releaseTriples: Record<Target, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** The executable's file name on the target's platform. */
export function executableName(name: string, target: Target): string {
  return target.startsWith("win32-") ? `${name}.exe` : name;
}

/**
 * Where a staged native executable lands in a release or desktop bundle: `<root>/<folder>/<name>`.
 * Both bundle layouts put `ace-media` in `media/` and `ace-files` in `files/`.
 */
export function stagedRustBinary(
  root: string,
  target: Target,
  folder: string,
  packageName: string,
): string {
  return join(root, folder, executableName(packageName, target));
}

export function assertRustLibraries(packageName: string, output: string): void {
  for (const line of output.split("\n")) {
    const library = line.trim().split(/\s/)[0];
    if (!library) continue;
    // The ELF interpreter and virtual DSO are supplied by the kernel/runtime.
    if (/^(linux-vdso\.so|\/.*\/ld-linux[^/]*\.so)/.test(library)) continue;
    // Match the screen helper and Spade: GNU Rust uses the shared unwinding runtime.
    if (!/^lib(c|m|dl|pthread|gcc_s)\.so(?:\.|$)/.test(library) || line.includes("not found"))
      throw new Error(`${packageName} has an unexpected dynamic dependency: ${line.trim()}`);
  }
}

/** A staged native must run on the oldest Linux ace supports, so check its glibc needs and links. */
export async function checkLinuxRustBinary(packageName: string, binary: string): Promise<void> {
  await assertLinuxRuntimeFloor([dirname(binary)]);
  assertRustLibraries(packageName, execFileSync("ldd", [binary], { encoding: "utf8" }));
}

export interface RustBinarySource {
  executable: string;
  triple: string;
  /** The signed executable `envName` named, rather than a build made here. */
  prebuilt: boolean;
}

/**
 * The release executable of a native Cargo workspace for `target`. It is built here from
 * `native/<workspace>` with the workspace's pinned toolchain and lockfile, unless `env[envName]`
 * names an already-built one: a signed desktop package's executable, whose platform signature the
 * archive must keep. Native builds run on the matching release host, inside Debian 12 on Linux.
 */
export async function rustBinarySource(options: {
  repo: string;
  target: Target;
  /** The workspace folder under `native/`, e.g. "media" or "files". */
  workspace: string;
  /** The Cargo package and executable name, e.g. "ace-media". */
  packageName: string;
  /** The environment variable naming an already-built executable, e.g. "ACE_MEDIA_BIN". */
  envName: string;
  env: NodeJS.ProcessEnv;
  sizeLimit: number;
  /** Extra environment for the build (a binary that stamps its version reads it then). */
  buildEnv?: NodeJS.ProcessEnv;
}): Promise<RustBinarySource> {
  const { repo, target, workspace, packageName, envName, env, sizeLimit, buildEnv } = options;
  if (target !== `${process.platform}-${process.arch}`)
    throw new Error(`Build and verify ${packageName} on a ${target} host`);
  const crate = join(repo, "native", workspace);
  const triple = releaseTriples[target];
  const override = env[envName] || undefined;
  const executable =
    override ?? join(crate, "target", triple, "release", executableName(packageName, target));
  if (!override)
    execFileSync(
      "cargo",
      ["build", "--release", "--locked", "-p", packageName, "--target", triple],
      { cwd: crate, env: { ...env, ...buildEnv }, stdio: "inherit" },
    );
  const info = await lstat(executable);
  if (!info.isFile()) throw new Error(`${packageName} is not a regular file: ${executable}`);
  if (info.size > sizeLimit) throw new Error(`${packageName} exceeds ${sizeLimit} bytes`);
  return { executable, triple, prebuilt: override !== undefined };
}

/** Copies a built executable into the bundle's `<folder>/`, runnable, and checks Linux links. */
export async function installRustBinary(options: {
  executable: string;
  root: string;
  target: Target;
  folder: string;
  packageName: string;
}): Promise<string> {
  const { executable, root, target, folder, packageName } = options;
  await mkdir(join(root, folder), { recursive: true });
  const destination = stagedRustBinary(root, target, folder, packageName);
  await copyFile(executable, destination);
  await chmod(destination, 0o755);
  if (target.startsWith("linux-")) await checkLinuxRustBinary(packageName, destination);
  return destination;
}
