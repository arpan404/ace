import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { assertAsciiScripts } from "./ascii-output.ts";

test("a bundled script with a raw curly quote in a regex is refused with its location", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-ascii-"));
  try {
    const clean = join(root, "clean.mjs");
    const dirty = join(root, "chunk.mjs");
    await writeFile(clean, 'const a=/^["\\u201C]+/g,b="\\u2019";');
    await writeFile(dirty, 'const a=1;const b=s=>s.replace(/^["“]+/g,"");');
    await expect(assertAsciiScripts([clean])).resolves.toBeUndefined();
    await expect(assertAsciiScripts([clean, dirty])).rejects.toThrow(
      /chunk\.mjs has a non-ASCII character at offset 35/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-script assets in the bundle are not checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-ascii-"));
  try {
    const skill = join(root, "SKILL.md");
    await writeFile(skill, "Use “quotes” freely");
    await expect(assertAsciiScripts([skill])).resolves.toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
