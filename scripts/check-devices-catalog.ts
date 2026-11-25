// SPDX-License-Identifier: Apache-2.0

/**
 * ADR 0225 safeguard 3: the device words live in `native/daemon/catalog/devices.json`, which
 * both backends read. The TypeScript imports it (`packages/devices/src/catalog.ts`); this check
 * renders every key through the built Rust addon and compares it with the file byte for byte,
 * so a word that drifted on one side fails the daemon's native check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(root, "native/daemon/catalog/devices.json"), "utf8"),
) as { platform: Record<string, { code: string; message: string; hint: string }> };

const library =
  process.platform === "win32"
    ? "ace_daemon_node.dll"
    : process.platform === "darwin"
      ? "libace_daemon_node.dylib"
      : "libace_daemon_node.so";
const path = join(root, "native/daemon/target/release", library);
const module = { exports: {} as Record<string, unknown> };
try {
  process.dlopen(module, path);
} catch (error) {
  throw new Error(`check:devices-catalog needs the release addon at ${path}`, { cause: error });
}
const addon = module.exports as { devicePlatformCatalogWord(key: string): string };

let failed = 0;
for (const [key, word] of Object.entries(catalog.platform)) {
  const answer = JSON.parse(addon.devicePlatformCatalogWord(key)) as {
    ok: boolean;
    value?: { code: string; message: string; hint: string };
  };
  const rendered = answer.value;
  if (
    !answer.ok ||
    rendered?.code !== word.code ||
    rendered.message !== word.message ||
    rendered.hint !== word.hint
  ) {
    failed++;
    console.error(`devices catalog: ${key} differs between Rust and devices.json`);
  }
}
if (failed > 0) process.exit(1);
console.log(`devices catalog: ${Object.keys(catalog.platform).length} words match Rust`);
