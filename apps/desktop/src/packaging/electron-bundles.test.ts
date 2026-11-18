import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { electronBundles } from "../../scripts/common.ts";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

it("the packaged app's main and preload bundles build without daemon-only native code", async () => {
  const bundles = electronBundles(join(tmpdir(), "ace-electron-bundles"), {
    ACE_VERSION: "0.0.0",
  });
  for (const options of bundles) {
    const result = await build({ ...options, write: false, logLevel: "silent" });
    expect(result.errors).toEqual([]);
  }
}, 120_000);

it("a dependency whose main build loads its own files at run time still works in the main bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-main-bundle-"));
  try {
    const entry = join(dir, "entry.ts");
    await writeFile(
      entry,
      'import { parse } from "jsonc-parser";\nexport const value = parse(\'{ "a": 1, // note\\n }\');\n',
    );
    const [main] = electronBundles(join(dir, "out"), { ACE_VERSION: "0.0.0" });
    await build({
      ...main,
      entryPoints: { main: entry },
      outdir: join(dir, "out"),
      // The main process reaches jsonc-parser through @ace/settings.
      nodePaths: [join(desktopRoot, "../../packages/settings/node_modules")],
      logLevel: "silent",
    });
    const bundled: { value: unknown } = await import(
      pathToFileURL(join(dir, "out", "main.mjs")).href
    );
    expect(bundled.value).toEqual({ a: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
