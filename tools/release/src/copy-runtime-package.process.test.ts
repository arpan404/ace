import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "vitest";
import { copyRuntimePackage } from "./copy-runtime-package.ts";

async function files(root: string, directory = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(root, path)));
    else found.push(relative(root, path));
  }
  return found.toSorted();
}

test("a staged runtime package keeps what runs and its notices, and leaves out sources and docs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "ace-runtime-package-"));
  try {
    const source = join(temporary, "koffi");
    const shipped = [
      "LICENSE.txt",
      "index.js",
      "lib/index.cjs",
      "package.json",
      "build/koffi.node",
      "dist/250.js.LICENSE.txt",
      "LICENSE.md",
      "src/koffi/index.js",
    ];
    const dropped = [
      "README.md",
      "CHANGELOG.md",
      "doc/start.md",
      "src/koffi/src/abi/abi_arm64.cc",
      "src/koffi/src/abi/abi_arm64_asm.S",
      "src/koffi/src/abi/abi_x64_win_asm.asm",
      "lib/native/base/base.hh",
      "lib/native/base/unicode.inc",
      "vendor/node-api-headers/include/node_api.h",
      "vendor/node-api-headers/def/node_api.def",
      "binding.gyp",
      "index.d.ts",
      "index.js.map",
      "node_modules/nested/index.js",
    ];
    for (const path of [...shipped, ...dropped]) {
      await mkdir(join(source, path, ".."), { recursive: true });
      await writeFile(join(source, path), "fixture");
    }
    const destination = join(temporary, "staged");
    await copyRuntimePackage(source, destination);
    expect(await files(destination)).toEqual(shipped.toSorted());
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
