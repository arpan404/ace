import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuitManifest } from "@ace/protocol/suits";
import { seedBuiltinSuits } from "./builtin-suits.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true });
});
async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ace-suits-"));
  homes.push(path);
  return path;
}

it("a first run fills the library with the shipped Suits, each one a valid Suit in its own folder", async () => {
  const library = join(await home(), ".ace", "suits");
  expect(await seedBuiltinSuits(library)).toEqual(["arcade-cabinet", "glasshouse"]);
  for (const id of await readdir(library)) {
    const manifest = SuitManifest.parse(
      JSON.parse(await readFile(join(library, id, "suit.json"), "utf8")),
    );
    expect(manifest.id).toBe(id);
  }
  // A Suit's scene, styles, ornaments, sprites and bundled fonts are copied with it.
  const arcade = join(library, "arcade-cabinet");
  expect(await readFile(join(arcade, "scene.js"), "utf8")).toContain("ace.scene(");
  expect(await readFile(join(arcade, "suit.css"), "utf8")).toContain("[data-part=");
  expect(await readdir(join(arcade, "assets", "ornaments"))).toContain("title-plate.svg");
  expect(await readdir(join(arcade, "assets", "fonts"))).toContain("Silkscreen-OFL.txt");
  const glasshouse = join(library, "glasshouse");
  expect(await readFile(join(glasshouse, "celebration.js"), "utf8")).toContain("ace.scene(");
  expect(await readdir(join(glasshouse, "assets", "fonts"))).toEqual(
    expect.arrayContaining(["Manrope.ttf", "Manrope-OFL.txt"]),
  );
});

it("a library that already exists is left as the person made it, even with a shipped Suit removed", async () => {
  const library = join(await home(), "suits");
  await mkdir(join(library, "my-own"), { recursive: true });
  expect(await seedBuiltinSuits(library)).toEqual([]);
  expect(await readdir(library)).toEqual(["my-own"]);
});
