import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ReleaseTarget } from "@ace/protocol";
import type { z } from "zod";
import { installRustBinary, rustBinarySource, stagedRustBinary } from "./rust-binary.ts";
import { collectRustLicenses } from "./rust-licenses.ts";

type Target = z.infer<typeof ReleaseTarget>;
export const mediaSizeLimit = 8_000_000;
export const stagedAceMedia = (root: string, target: Target) =>
  stagedRustBinary(root, target, "media", "ace-media");

/**
 * Stages ace-media, the daemon's media process: built from `native/media` on the matching release
 * host, or, for signed standalone archives, the executable `ACE_MEDIA_BIN` names from the signed
 * desktop package, preserving its platform signature before the archive checksums are computed.
 */
export async function stageAceMedia(options: {
  repo: string;
  root: string;
  target: Target;
  version: string;
  env: NodeJS.ProcessEnv;
}): Promise<"built" | "prebuilt"> {
  const { repo, root, target, version, env } = options;
  const { executable, triple, prebuilt } = await rustBinarySource({
    repo,
    target,
    workspace: "media",
    packageName: "ace-media",
    envName: "ACE_MEDIA_BIN",
    env,
    sizeLimit: mediaSizeLimit,
    buildEnv: { ACE_MEDIA_VERSION: version },
  });
  const reported = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
  if (reported !== version)
    throw new Error(
      `ace-media reports version ${JSON.stringify(reported.slice(0, 80))}, not ${version}`,
    );
  await installRustBinary({ executable, root, target, folder: "media", packageName: "ace-media" });
  await collectRustLicenses({
    repo,
    workspace: "media",
    packageName: "ace-media",
    triple,
    output: join(root, "media"),
  });
  return prebuilt ? "prebuilt" : "built";
}
