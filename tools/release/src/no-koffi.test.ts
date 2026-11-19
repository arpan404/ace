import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { expect, test } from "vitest";
import { z } from "zod";
import { assertNoKoffi, daemonWithoutKoffi } from "./no-koffi.ts";

const loader = resolve(import.meta.dirname, "../../../packages/provider-kit/src/koffi.ts");

/** Bundles `source` the way the daemon's scripts are bundled (ESM for Node) into one file. */
async function daemonScript(
  root: string,
  source: string,
  plugins: Plugin[] = [daemonWithoutKoffi],
): Promise<string> {
  const entry = join(root, "entry.ts");
  const outfile = join(root, "out.mjs");
  await writeFile(entry, source);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins,
  });
  return outfile;
}

test("daemon code that shares provider-kit's koffi loader bundles without koffi and fails loudly if called", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-release-ffi-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const script = await daemonScript(
    root,
    `import { loadKoffi } from ${JSON.stringify(loader)}; export const load = loadKoffi;`,
  );
  await expect(assertNoKoffi([script])).resolves.toBeUndefined();
  const loaded: unknown = await import(pathToFileURL(script).href);
  const { load } = z.object({ load: z.function() }).parse(loaded);
  expect(() => load()).toThrow(/bun:ffi/);
});

test("a daemon script that would require koffi at runtime is refused, naming the script", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-release-ffi-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  // The loader as the desktop bundles it: a lazy require esbuild cannot see.
  const script = await daemonScript(
    root,
    `import { loadKoffi } from ${JSON.stringify(loader)}; export const load = loadKoffi;`,
    [],
  );
  await expect(assertNoKoffi([script])).rejects.toThrow(/out\.mjs loads koffi/);
});

test("daemon code that imports koffi fails the bundle, naming the importer", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(join(tmpdir(), "ace-release-ffi-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  await expect(
    daemonScript(root, 'import koffi from "koffi"; export const native = koffi;'),
  ).rejects.toThrow(/koffi is not shipped with the daemon \(imported by .*entry\.ts\)/);
});
