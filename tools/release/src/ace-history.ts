import { join } from "node:path";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { installRustBinary, rustBinarySource, stagedRustBinary } from "./rust-binary.ts";
import { collectRustLicenses } from "./rust-licenses.ts";

type Target = z.infer<typeof ReleaseTarget>;
export const historySizeLimit = 8_000_000;
export const stagedAceHistory = (root: string, target: Target) =>
  stagedRustBinary(root, target, "history", "ace-history");

/**
 * Stages ace-history, the daemon's saved-history reader (ADR 0206), in `history/` beside
 * `media/` and `files/`: built from `native/history` on the matching release host with the
 * workspace's pinned toolchain and lockfile, or, for signed standalone archives, the executable
 * `ACE_HISTORY_BIN` names from the signed desktop package.
 */
export async function stageAceHistory(options: {
  repo: string;
  root: string;
  target: Target;
  env: NodeJS.ProcessEnv;
}): Promise<"built" | "prebuilt"> {
  const { repo, root, target, env } = options;
  const { executable, triple, prebuilt } = await rustBinarySource({
    repo,
    target,
    workspace: "history",
    packageName: "ace-history",
    envName: "ACE_HISTORY_BIN",
    env,
    sizeLimit: historySizeLimit,
  });
  await installRustBinary({
    executable,
    root,
    target,
    folder: "history",
    packageName: "ace-history",
  });
  await collectRustLicenses({
    repo,
    workspace: "history",
    packageName: "ace-history",
    triple,
    output: join(root, "history"),
  });
  return prebuilt ? "prebuilt" : "built";
}
