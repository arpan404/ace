import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { precompress, precompressMinBytes } from "./precompress.ts";

test("large built code gets brotli and gzip copies; small files, maps and the page do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-precompress-"));
  try {
    const big = "console.log('ace');\n".repeat(precompressMinBytes / 10);
    const files: Record<string, string> = {
      "assets/initial-abc.js": big,
      "assets/tiny-abc.js": "console.log(1);\n",
      "assets/initial-abc.js.map": big,
      "index.html": big,
    };
    await mkdir(join(dir, "assets"));
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    const bundle = Object.fromEntries(
      Object.entries(files).map(([fileName, source]) => [
        fileName,
        { type: "asset" as const, fileName, source },
      ]),
    );
    const plugin = precompress();
    const write = plugin.writeBundle;
    const run = typeof write === "function" ? write : write?.handler;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the hook reads only `dir` and each output's name and source.
    await run?.call({} as never, { dir } as never, bundle as never);
    expect((await readdir(join(dir, "assets"))).toSorted()).toEqual([
      "initial-abc.js",
      "initial-abc.js.br",
      "initial-abc.js.gz",
      "initial-abc.js.map",
      "tiny-abc.js",
    ]);
    expect((await readdir(dir)).toSorted()).toEqual(["assets", "index.html"]);
    const br = brotliDecompressSync(await readFile(join(dir, "assets/initial-abc.js.br")));
    const gz = gunzipSync(await readFile(join(dir, "assets/initial-abc.js.gz")));
    expect(br.toString("utf8")).toBe(big);
    expect(gz.toString("utf8")).toBe(big);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
