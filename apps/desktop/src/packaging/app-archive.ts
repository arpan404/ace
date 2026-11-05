import { open, stat } from "node:fs/promises";
import { z } from "zod";

/**
 * The most app.asar may weigh. It holds main, preload and the web renderer (about 82 MB in
 * November 2026); a package that bundled the desktop package's dependency tree weighed 466 MB.
 */
export const appArchiveLimitBytes = 160 * 1024 * 1024;

type ArchiveNode = { files?: Record<string, ArchiveNode> | undefined };
const archiveNode: z.ZodType<ArchiveNode> = z.lazy(() =>
  z.looseObject({ files: z.record(z.string(), archiveNode).optional() }),
);

/**
 * Every path in an asar archive's index, files and folders, `/`-separated. The archive starts
 * with two pickles: an 8-byte one holding the size of the second, then the second, whose
 * payload is a length-prefixed JSON index (`{ files: { name: { files | size, offset } } }`).
 */
export async function appArchivePaths(file: string): Promise<string[]> {
  const handle = await open(file, "r");
  try {
    const sizes = Buffer.alloc(16);
    await handle.read(sizes, 0, 16, 0);
    const length = sizes.readUInt32LE(12);
    const json = Buffer.alloc(length);
    await handle.read(json, 0, length, 16);
    const root = archiveNode.parse(JSON.parse(json.toString("utf8")));
    const paths: string[] = [];
    const walk = (node: ArchiveNode, prefix: string) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        paths.push(`${prefix}${name}`);
        walk(child, `${prefix}${name}/`);
      }
    };
    walk(root, "");
    return paths;
  } finally {
    await handle.close();
  }
}

/**
 * Refuses an app.asar that packs a `node_modules` folder or outgrows `limit`. Everything the app
 * runs is bundled, and native packages ship beside the archive (scripts/beside-app.ts), so a
 * `node_modules` inside means electron-builder packed a dependency tree it should not have.
 */
export async function checkAppArchive(file: string, limit = appArchiveLimitBytes): Promise<void> {
  const packed = (await appArchivePaths(file)).filter((path) =>
    path.split("/").includes("node_modules"),
  );
  if (packed.length > 0)
    throw new Error(
      `${file} packs node_modules (${packed.slice(0, 3).join(", ")}${packed.length > 3 ? ", …" : ""}); app.asar must hold only the bundled app`,
    );
  const { size } = await stat(file);
  if (size > limit)
    throw new Error(
      `${file} is ${Math.round(size / 1024 / 1024)} MB, over the ${Math.round(limit / 1024 / 1024)} MB limit for app.asar`,
    );
}
