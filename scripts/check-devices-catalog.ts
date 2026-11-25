// SPDX-License-Identifier: Apache-2.0

/**
 * ADR 0225 safeguard 3: the device words live in `native/daemon/catalog/devices.json`, which
 * both backends read. The TypeScript imports it (`packages/devices/src/catalog.ts`); this check
 * fails when a device source spells a word itself, and renders every key through the built Rust
 * addon to compare it with the file byte for byte.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findLiteral, stripTestItems } from "./catalog-scan.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(root, "native/daemon/catalog/devices.json"), "utf8"),
) as {
  platform: Record<string, { code: string; message: string; hint: string }>;
  tools?: Record<string, string>;
};

/**
 * Hint phrases deliberately shared by unrelated refusals: they name a next step, not a word the
 * catalog owns, so a source may spell them.
 */
const genericHints = new Set([
  "Refresh the device list.",
  "Restart ace.",
  "Read the UI tree again.",
  "Retry.",
  "Retry shortly.",
]);

let failed = 0;

/** Every `.ts` file the TypeScript devices backend runs, tests excluded. */
function sources(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory()) return [];
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    if (entry.name === "catalog.ts") return [];
    return [path];
  });
}

const files = sources(join(root, "packages/devices/src"));
const texts = files.map((file) => ({ file, text: readFileSync(file, "utf8") }));

/**
 * The Rust that runs: a `#[cfg(test)]` item is blanked out, since a test may name a word it
 * asserts on, and everything after that item is still checked.
 */
function rustSources(directory: string): { file: string; text: string }[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    const path = join(entry.parentPath, entry.name);
    if (entry.isDirectory() || !entry.name.endsWith(".rs")) return [];
    return [{ file: path, text: stripTestItems(readFileSync(path, "utf8")) }];
  });
}
const rust = rustSources(join(root, "native/daemon/crates"));

for (const [key, word] of Object.entries(catalog.platform)) {
  for (const field of ["message", "hint"] as const) {
    const literal = word[field];
    if (field === "hint" && genericHints.has(literal)) continue;
    for (const { file, text } of texts) {
      for (const line of findLiteral(text, literal)) {
        failed++;
        console.error(
          `devices catalog: ${key}'s ${field} is spelled at ${relative(root, file)}:${line}; read it from catalog.ts`,
        );
      }
    }
  }
}
for (const [key, literal] of Object.entries(catalog.tools ?? {})) {
  for (const { file, text } of texts) {
    for (const line of findLiteral(text, literal)) {
      failed++;
      console.error(
        `devices catalog: ${key} is spelled at ${relative(root, file)}:${line}; read it from catalog.ts`,
      );
    }
  }
}
for (const [key, word] of Object.entries(catalog.platform)) {
  for (const field of ["message", "hint"] as const) {
    const literal = word[field];
    if (field === "hint" && genericHints.has(literal)) continue;
    for (const { file, text } of rust) {
      for (const line of findLiteral(text, literal)) {
        failed++;
        console.error(
          `devices catalog: ${key}'s ${field} is spelled at ${relative(root, file)}:${line}; read it from words.rs`,
        );
      }
    }
  }
}
for (const [key, literal] of Object.entries(catalog.tools ?? {})) {
  for (const { file, text } of rust) {
    for (const line of findLiteral(text, literal)) {
      failed++;
      console.error(
        `devices catalog: ${key} is spelled at ${relative(root, file)}:${line}; read it from words.rs`,
      );
    }
  }
}

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
const addon = module.exports as {
  devicePlatformCatalogWord(key: string): string;
  devicePlatformCatalogHint(key: string): string | null;
};

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
for (const [key, literal] of Object.entries(catalog.tools ?? {})) {
  if (addon.devicePlatformCatalogHint(key) !== literal) {
    failed++;
    console.error(`devices catalog: ${key} differs between Rust and devices.json`);
  }
}
if (failed > 0) process.exit(1);
console.log(
  `devices catalog: ${Object.keys(catalog.platform).length} words and ${Object.keys(catalog.tools ?? {}).length} tool words match Rust`,
);
