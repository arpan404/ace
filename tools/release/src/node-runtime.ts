import { rm } from "node:fs/promises";
import { join } from "node:path";
import { extract } from "tar";
import type { z } from "zod";
import type { ReleaseTarget as ReleaseTargets } from "@ace/protocol";
import { downloadArchive, hashFile } from "@ace/service";

export type ReleaseTarget = z.infer<typeof ReleaseTargets>;

/** The Node runtime ace ships beside its daemon (standalone archive and desktop app). */
export const nodeVersion = "24.13.0";
/** Pinned from the official Node release SHASUMS256.txt. */
const hashes: Record<ReleaseTarget, string> = {
  "darwin-arm64": "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
  "darwin-x64": "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
  "linux-arm64": "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
  "linux-x64": "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
};

/**
 * Puts `bin/node` and Node's `LICENSE` for `target` into `destination`. The official archive
 * is cached in `cacheDir` and used only while its SHA-256 matches the pin; otherwise it is
 * downloaded again and verified before extraction.
 */
export async function stageNodeRuntime(options: {
  target: ReleaseTarget;
  version: string;
  cacheDir: string;
  destination: string;
}): Promise<void> {
  const { target, cacheDir } = options;
  const archive = `node-v${nodeVersion}-${target}.tar.gz`;
  const archivePath = join(cacheDir, archive);
  try {
    if ((await hashFile(archivePath)) !== hashes[target])
      throw new Error("Untrusted cached Node runtime");
  } catch {
    await rm(archivePath, { force: true });
    const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/${archive}`, {
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = Number(response.headers.get("content-length"));
    await downloadArchive(response, archivePath, {
      version: options.version,
      target,
      channel: "stable",
      archive: "ace-node.tar.gz",
      bytes,
      sha256: hashes[target],
    });
  }
  await extract({
    file: archivePath,
    cwd: options.destination,
    strip: 1,
    filter: (path) => path.endsWith("/bin/node") || path.endsWith("/LICENSE"),
  });
}
