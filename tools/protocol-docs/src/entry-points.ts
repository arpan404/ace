import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { protocolEntryPoints } from "./catalog.ts";

const manifest = z.object({ exports: z.record(z.string(), z.string()) });

/** Fail when a new public schema entry point has not yet been added to discovery. */
export async function validateProtocolEntries(root: string): Promise<void> {
  const path = join(root, "packages/protocol/package.json");
  if ((await stat(path)).size > 64 * 1024)
    throw new Error("Protocol export manifest exceeds 64 KiB");
  const config = manifest.parse(JSON.parse(await readFile(path, "utf8")));
  for (const entry of Object.keys(config.exports))
    if (!protocolEntryPoints.has(entry))
      throw new Error(
        `Undocumented protocol entry point ${entry}; add its public exports to protocolCatalog`,
      );
  for (const entry of protocolEntryPoints.keys())
    if (!Object.hasOwn(config.exports, entry))
      throw new Error(`Protocol catalog entry point ${entry} is no longer exported`);
}
