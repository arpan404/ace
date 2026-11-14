import { createHash } from "node:crypto";
import { readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * The file beside `ace.mjs` naming the exact daemon build (ADR 0125): a SHA-256 over every file
 * the bundle step put in the release root, by relative path and contents. The entry, its
 * chunks, every separately bundled helper (`*-worker.mjs`, `*-process.mjs`, `*-host.mjs`),
 * runtime packages and native and wasm assets all count, so changing any one of them changes
 * the id, and rebuilding identical files keeps it. The daemon reads it as `build-id`
 * (`apps/daemon/src/stored-shape.ts`, `runningBuildId`).
 */
export const buildIdFile = "build-id";

async function files(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(root, path)));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(path);
  }
  return found;
}

/** The digest of every file under `root` except an existing build id; deterministic. */
export async function releaseDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  const paths = (await files(root))
    .map((path) => ({ path, name: relative(root, path).split(sep).join("/") }))
    .filter(({ name }) => name !== buildIdFile)
    .toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { path, name } of paths) {
    let contents: Buffer;
    try {
      contents = await readFile(path);
    } catch {
      // A dangling link: its target names it.
      contents = Buffer.from(`link:${await readlink(path)}`);
    }
    hash.update(`${name}\0${contents.length}\0`).update(contents);
  }
  return hash.digest("hex");
}

/** Write the build id of the daemon bundled into `root`. Run after every file is in place. */
export async function writeBuildId(root: string): Promise<string> {
  const id = await releaseDigest(root);
  await writeFile(join(root, buildIdFile), `${id}\n`);
  return id;
}
