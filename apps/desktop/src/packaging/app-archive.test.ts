import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { appArchivePaths, checkAppArchive } from "./app-archive.ts";

type Tree = { [name: string]: string | Tree };

/**
 * Writes an asar archive in the layout Electron reads: an 8-byte pickle holding the header
 * pickle's size, the header pickle (payload size, JSON length, JSON padded to 4 bytes), then
 * the file contents at the offsets the index names.
 */
async function archive(path: string, tree: Tree, padding = 0): Promise<string> {
  const bodies: Buffer[] = [];
  let offset = 0;
  const index = (node: Tree): object => ({
    files: Object.fromEntries(
      Object.entries(node).map(([name, value]) => {
        if (typeof value !== "string") return [name, index(value)];
        const body = Buffer.from(value);
        bodies.push(body);
        const entry = { size: body.length, offset: String(offset) };
        offset += body.length;
        return [name, entry];
      }),
    ),
  });
  const json = Buffer.from(JSON.stringify(index(tree)));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(16 + padded);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(8 + padded, 4);
  header.writeUInt32LE(4 + padded, 8);
  header.writeUInt32LE(json.length, 12);
  json.copy(header, 16);
  await writeFile(path, Buffer.concat([header, ...bodies, Buffer.alloc(padding)]));
  return path;
}

async function folder(onTestFinished: (cleanup: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), "ace-app-archive-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

const bundledApp: Tree = {
  "package.json": '{"name":"ace"}',
  "main.mjs": "export {};",
  chunks: { "link-1.mjs": "export {};" },
  renderer: { "index.html": "<!doctype html>", assets: { "index.js": "1" } },
};

test("an archive of the bundled app passes and lists every file and folder", async ({
  onTestFinished,
}) => {
  const file = await archive(join(await folder(onTestFinished), "app.asar"), bundledApp);
  await expect(checkAppArchive(file)).resolves.toBeUndefined();
  expect((await appArchivePaths(file)).toSorted()).toEqual([
    "chunks",
    "chunks/link-1.mjs",
    "main.mjs",
    "package.json",
    "renderer",
    "renderer/assets",
    "renderer/assets/index.js",
    "renderer/index.html",
  ]);
});

test("an archive that packed a dependency tree is refused, naming what it packed", async ({
  onTestFinished,
}) => {
  const file = await archive(join(await folder(onTestFinished), "app.asar"), {
    ...bundledApp,
    node_modules: { zod: { "package.json": "{}" } },
  });
  await expect(checkAppArchive(file)).rejects.toThrow(/packs node_modules \(node_modules,/);
});

test("a node_modules folder nested under the renderer is refused too", async ({
  onTestFinished,
}) => {
  const file = await archive(join(await folder(onTestFinished), "app.asar"), {
    ...bundledApp,
    renderer: { node_modules: { react: { "index.js": "" } } },
  });
  await expect(checkAppArchive(file)).rejects.toThrow("renderer/node_modules");
});

test("an archive one byte over the limit is refused, and one exactly at it passes", async ({
  onTestFinished,
}) => {
  const file = await archive(
    join(await folder(onTestFinished), "app.asar"),
    bundledApp,
    2 * 1024 * 1024,
  );
  const { size } = await stat(file);
  await expect(checkAppArchive(file, size)).resolves.toBeUndefined();
  await expect(checkAppArchive(file, size - 1)).rejects.toThrow(
    `is ${size} bytes (2.0 MB), over the ${size - 1}-byte (2.0 MB) limit`,
  );
});
