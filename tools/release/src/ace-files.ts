import { join } from "node:path";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { installRustBinary, rustBinarySource, stagedRustBinary } from "./rust-binary.ts";
import { collectRustLicenses } from "./rust-licenses.ts";

type Target = z.infer<typeof ReleaseTarget>;
export const filesSizeLimit = 8_000_000;
export const stagedAceFiles = (root: string, target: Target) =>
  stagedRustBinary(root, target, "files", "ace-files");

/**
 * Stages ace-files, the daemon's file system process: built from `native/files` on the matching
 * release host with the workspace's pinned toolchain and lockfile, or, for signed standalone
 * archives, the executable `ACE_FILES_BIN` names from the signed desktop package, preserving its
 * platform signature before the archive checksums are computed. Its version is reported on the
 * files-wire hello frame, not its command line, so staging asks for no version; the smoke check
 * performs the handshake.
 */
export async function stageAceFiles(options: {
  repo: string;
  root: string;
  target: Target;
  env: NodeJS.ProcessEnv;
}): Promise<"built" | "prebuilt"> {
  const { repo, root, target, env } = options;
  const { executable, triple, prebuilt } = await rustBinarySource({
    repo,
    target,
    workspace: "files",
    packageName: "ace-files",
    envName: "ACE_FILES_BIN",
    env,
    sizeLimit: filesSizeLimit,
  });
  await installRustBinary({ executable, root, target, folder: "files", packageName: "ace-files" });
  await collectRustLicenses({
    repo,
    workspace: "files",
    packageName: "ace-files",
    triple,
    output: join(root, "files"),
  });
  return prebuilt ? "prebuilt" : "built";
}
