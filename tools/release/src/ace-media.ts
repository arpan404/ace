import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { assertLinuxRuntimeFloor } from "./glibc.ts";
import { collectMediaLicenses } from "./licenses.ts";

type Target = z.infer<typeof ReleaseTarget>;
const triples: Record<Target, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};
export const mediaSizeLimit = 8_000_000;
export const stagedAceMedia = (root: string, target: Target) =>
  join(root, "media", target.startsWith("win32-") ? "ace-media.exe" : "ace-media");

export function assertMediaLibraries(output: string): void {
  for (const line of output.split("\n")) {
    const library = line.trim().split(/\s/)[0];
    if (!library) continue;
    // The ELF interpreter and virtual DSO are supplied by the kernel/runtime.
    if (/^(linux-vdso\.so|\/.*\/ld-linux[^/]*\.so)/.test(library)) continue;
    // Match the screen helper and Spade: GNU Rust uses the shared unwinding runtime.
    if (!/^lib(c|m|dl|pthread|gcc_s)\.so(?:\.|$)/.test(library) || line.includes("not found"))
      throw new Error(`ace-media has an unexpected dynamic dependency: ${line.trim()}`);
  }
}

export async function checkLinuxMedia(binary: string): Promise<void> {
  await assertLinuxRuntimeFloor([join(binary, "..")]);
  assertMediaLibraries(execFileSync("ldd", [binary], { encoding: "utf8" }));
}

/**
 * Native builds run on the matching release host, inside Debian 12 on Linux.
 * For signed standalone archives, ACE_MEDIA_BIN names the executable from the signed desktop
 * package, preserving its platform signature before the archive checksums are computed.
 */
export async function stageAceMedia(options: {
  repo: string;
  root: string;
  target: Target;
  version: string;
  env: NodeJS.ProcessEnv;
}): Promise<"built" | "prebuilt"> {
  const { repo, root, target, version, env } = options;
  if (target !== `${process.platform}-${process.arch}`)
    throw new Error(`Build and verify ace-media on a ${target} host`);
  const crate = join(repo, "native/media");
  const name = target.startsWith("win32-") ? "ace-media.exe" : "ace-media";
  const triple = triples[target];
  const source = env.ACE_MEDIA_BIN ?? join(crate, "target", triple, "release", name);
  if (!env.ACE_MEDIA_BIN)
    execFileSync(
      "cargo",
      ["build", "--release", "--locked", "-p", "ace-media", "--target", triple],
      {
        cwd: crate,
        env: { ...env, ACE_MEDIA_VERSION: version },
        stdio: "inherit",
      },
    );
  const info = await lstat(source);
  if (!info.isFile()) throw new Error(`ace-media is not a regular file: ${source}`);
  if (info.size > mediaSizeLimit) throw new Error(`ace-media exceeds ${mediaSizeLimit} bytes`);
  const reported = execFileSync(source, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  if (reported !== version)
    throw new Error(
      `ace-media reports version ${JSON.stringify(reported.slice(0, 80))}, not ${version}`,
    );
  await mkdir(join(root, "media"), { recursive: true });
  const destination = stagedAceMedia(root, target);
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  if (target.startsWith("linux-")) await checkLinuxMedia(destination);
  await collectMediaLicenses(repo, join(root, "media"));
  return env.ACE_MEDIA_BIN ? "prebuilt" : "built";
}
