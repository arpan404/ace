import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { electronBundles } from "../../scripts/common.ts";

it("the packaged app's main and preload bundles build without daemon-only native code", async () => {
  const bundles = electronBundles(join(tmpdir(), "ace-electron-bundles"), {
    ACE_VERSION: "0.0.0",
  });
  for (const options of bundles) {
    const result = await build({ ...options, write: false, logLevel: "silent" });
    expect(result.errors).toEqual([]);
  }
}, 120_000);
