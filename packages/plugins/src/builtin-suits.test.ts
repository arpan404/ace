import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuitManifest } from "@ace/protocol/suits";
import { seedBuiltinSuits } from "./builtin-suits.ts";

/** Every folder ace ships in builtin-suits is one Suit. */
const shipped = new URL("../builtin-suits", import.meta.url).pathname;

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
  expect(await seedBuiltinSuits(library)).toEqual(
    (await readdir(shipped, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted(),
  );
  for (const id of (await readdir(library)).filter((name) => !name.startsWith("."))) {
    const manifest = SuitManifest.parse(
      JSON.parse(await readFile(join(library, id, "suit.json"), "utf8")),
    );
    expect(manifest.id).toBe(id);
  }
});

/** A shipped root holding minimal Suit folders with these ids. */
async function shippedWith(ids: string[]): Promise<string> {
  const root = await home();
  for (const id of ids) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, "suit.json"), JSON.stringify({ id }));
  }
  return root;
}

async function suitsIn(library: string): Promise<string[]> {
  return (await readdir(library)).filter((name) => !name.startsWith(".")).toSorted();
}

it("a Suit shipped in a later release reaches a library that already exists", async () => {
  const library = join(await home(), "suits");
  expect(await seedBuiltinSuits(library, await shippedWith(["tarn"]))).toEqual(["tarn"]);
  expect(await seedBuiltinSuits(library, await shippedWith(["tarn", "mizzle"]))).toEqual([
    "mizzle",
  ]);
  expect(await suitsIn(library)).toEqual(["mizzle", "tarn"]);
});

it("a shipped Suit the person removed is never copied back", async () => {
  const library = join(await home(), "suits");
  const root = await shippedWith(["tarn", "mizzle"]);
  await seedBuiltinSuits(library, root);
  await rm(join(library, "tarn"), { recursive: true });
  expect(await seedBuiltinSuits(library, root)).toEqual([]);
  expect(await suitsIn(library)).toEqual(["mizzle"]);
});

it("a library left empty by a failed first seed is filled on the next start", async () => {
  const library = join(await home(), "suits");
  await expect(seedBuiltinSuits(library, join(await home(), "missing"))).rejects.toThrow();
  expect(await seedBuiltinSuits(library, await shippedWith(["tarn"]))).toEqual(["tarn"]);
  expect(await suitsIn(library)).toEqual(["tarn"]);
});

it("a folder the person already has under a shipped id is left as they made it", async () => {
  const library = join(await home(), "suits");
  await mkdir(join(library, "tarn"), { recursive: true });
  await writeFile(join(library, "tarn", "suit.json"), "mine");
  expect(await seedBuiltinSuits(library, await shippedWith(["tarn"]))).toEqual([]);
  expect(await readFile(join(library, "tarn", "suit.json"), "utf8")).toBe("mine");
});
