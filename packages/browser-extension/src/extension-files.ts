import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extensionFiles } from "./extension-bundle.gen.ts";
import { extensionManifest } from "./manifest.ts";

/**
 * Writes the unpacked extension to `directory`, replacing what was there, for the person to load
 * from `chrome://extensions`. The directory is written beside it and renamed into place.
 */
export async function writeExtension(directory: string): Promise<void> {
  const staging = `${directory}.partial`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o755 });
  await writeFile(
    join(staging, "manifest.json"),
    `${JSON.stringify(extensionManifest(), null, 2)}\n`,
  );
  for (const [name, contents] of Object.entries(extensionFiles))
    await writeFile(join(staging, name), contents);
  await rm(directory, { recursive: true, force: true });
  await rename(staging, directory);
}
