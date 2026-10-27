import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { bundleDaemon } from "@ace/release";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.runIf(process.platform === "win32")(
  "a Windows daemon bundle loads every workspace addon from beside ace.mjs",
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-bundle-addon-"));
    roots.push(root);
    const publicKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    await bundleDaemon(resolve(import.meta.dirname, "../../.."), root, publicKey);
    expect(existsSync(join(root, "descriptor.node"))).toBe(true);
    const scripts = (await readdir(root)).filter((name) => name.endsWith(".mjs"));
    const loads = { stale: 0, bundled: 0 };
    for (const name of scripts) {
      const text = await readFile(join(root, name), "utf8");
      loads.stale += text.split('"../dist/descriptor.node"').length - 1;
      loads.bundled += text.split('"./descriptor.node"').length - 1;
    }
    expect(loads.stale).toBe(0);
    // The POSIX binding and the Windows binding each load it.
    expect(loads.bundled).toBeGreaterThanOrEqual(2);
  },
);
