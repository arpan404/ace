import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { noNativeModules } from "./no-native-modules.ts";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function bundle(files: Record<string, string>): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "ace-no-native-"));
  for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents);
  await build({
    entryPoints: [join(root, "entry.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [noNativeModules],
  });
}

it("fails a bundle that reaches koffi through another module, naming that module", async () => {
  const failure = bundle({
    "entry.ts": 'import { probe } from "./identity.ts"; console.log(probe);',
    "identity.ts": 'import koffi from "koffi"; export const probe = koffi;',
  });
  await expect(failure).rejects.toThrow(/koffi is native code.*identity\.ts/);
});

it("fails a bundle that imports a .node addon", async () => {
  await expect(bundle({ "entry.ts": 'import "./addon.node";' })).rejects.toThrow(
    /addon\.node is native code/,
  );
});

it("fails a bundle that imports node-pty", async () => {
  await expect(bundle({ "entry.ts": 'import "node-pty/lib/index.js";' })).rejects.toThrow(
    /node-pty\/lib\/index\.js is native code/,
  );
});

it("lets a bundle of plain JavaScript through", async () => {
  await expect(
    bundle({
      "entry.ts":
        'import { join } from "node:path"; import { a } from "./a.ts"; console.log(join(a));',
      "a.ts": 'export const a = "koffi-free";',
    }),
  ).resolves.toBeUndefined();
});
