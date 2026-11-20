import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ArchiveFile } from "@ace/marketplace";
import { MarketEntryType } from "@ace/protocol/marketplace";

/*
 * The market's seed (ADR 0168 phase 1) as plain folders: `seed/<type>/<name>/`. A Suit's or a
 * bot's seed folder holds only its `market.json`; its files are ace's own built-in Suit of that
 * id, or the agent package Spade ships as that template (`spade/templates/<id>/`, ADR 0200
 * §3.8), so the two never drift apart.
 */

export const seedRoot = join(import.meta.dirname, "../../seed");
export const builtinSuitsRoot = join(
  import.meta.dirname,
  "../../../../packages/plugins/builtin-suits",
);
/** Spade's built-in bot templates, each a version 3 package. */
export const templatesRoot = join(import.meta.dirname, "../../../../spade/templates");
export const seedVersion = "1.0.0";

export interface SeedEntry {
  type: MarketEntryType;
  name: string;
  version: string;
  files: ArchiveFile[];
}

async function filesIn(root: string): Promise<ArchiveFile[]> {
  const found: ArchiveFile[] = [];
  async function walk(folder: string) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      if (item.name === ".DS_Store") continue;
      const path = join(folder, item.name);
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) {
        const info = await stat(path);
        found.push({
          path: relative(root, path).split(sep).join("/"),
          executable: (info.mode & 0o111) !== 0,
          content: new Uint8Array(await readFile(path)),
        });
      }
    }
  }
  await walk(root);
  return found;
}

const folders = async (root: string) =>
  (await readdir(root, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .toSorted();

/** Every seed entry, with its files as they would be published. */
export async function readSeed(
  root = seedRoot,
  suitsRoot = builtinSuitsRoot,
  botsRoot = templatesRoot,
): Promise<SeedEntry[]> {
  const entries: SeedEntry[] = [];
  for (const typeFolder of await folders(root)) {
    const type = MarketEntryType.parse(typeFolder);
    for (const name of await folders(join(root, typeFolder))) {
      const own = await filesIn(join(root, typeFolder, name));
      const shipped = type === "suit" ? suitsRoot : type === "spade-bot" ? botsRoot : undefined;
      const files = shipped
        ? [
            ...(await filesIn(join(shipped, name))).filter((file) => file.path !== "market.json"),
            ...own,
          ]
        : own;
      entries.push({ type, name, version: seedVersion, files });
    }
  }
  return entries;
}
