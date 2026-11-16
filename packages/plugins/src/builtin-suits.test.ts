import { afterEach, expect, it } from "vitest";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  mkdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SuitManifest } from "@ace/protocol/suits";
import { folderHash, nextBuiltinsLock, type BuiltinsLock } from "./builtin-lock.ts";
import { packBuiltinSuits, seedBuiltinSuits, type ShippedSuits } from "./builtin-suits.ts";

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
  const seeded = await seedBuiltinSuits(library);
  expect(seeded.stale).toEqual([]);
  expect(seeded.installed).toEqual(
    (await readdir(shipped, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .toSorted(),
  );
  for (const id of await suitsIn(library)) {
    const manifest = SuitManifest.parse(
      JSON.parse(await readFile(join(library, id, "suit.json"), "utf8")),
    );
    expect(manifest.id).toBe(id);
  }
});

/**
 * A release: a shipped root holding minimal Suit folders, each `id` with the given contents
 * (default `v1`), and a lock built the way `bun run builtins:lock` builds it on top of the
 * previous release's lock, so a changed Suit goes up a version and keeps its old hash.
 */
let lastLock: BuiltinsLock | undefined;
async function release(suits: Record<string, string> | string[]): Promise<ShippedSuits> {
  const root = await home();
  const entries: [string, string][] = Array.isArray(suits)
    ? suits.map((id) => [id, "v1"])
    : Object.entries(suits);
  const hashes: Record<string, string> = {};
  for (const [id, content] of entries) {
    await mkdir(join(root, id), { recursive: true });
    await writeFile(join(root, id, "suit.json"), JSON.stringify({ id, content }));
    hashes[id] = await folderHash(join(root, id));
  }
  lastLock = nextBuiltinsLock(lastLock, { skills: {}, suits: hashes });
  const lock = join(await home(), "builtins-lock.json");
  await writeFile(lock, JSON.stringify(lastLock));
  return { root, lock };
}
afterEach(() => {
  lastLock = undefined;
});

async function suitsIn(library: string): Promise<string[]> {
  return (await readdir(library)).filter((name) => !name.startsWith(".")).toSorted();
}
async function contentOf(library: string, id: string): Promise<string> {
  return JSON.parse(await readFile(join(library, id, "suit.json"), "utf8")).content;
}

it("a Suit shipped in a later release reaches a library that already exists", async () => {
  const library = join(await home(), "suits");
  expect((await seedBuiltinSuits(library, await release(["tarn"]))).installed).toEqual(["tarn"]);
  expect((await seedBuiltinSuits(library, await release(["tarn", "mizzle"]))).installed).toEqual([
    "mizzle",
  ]);
  expect(await suitsIn(library)).toEqual(["mizzle", "tarn"]);
});

it("an update replaces a shipped Suit the person never changed with the new version", async () => {
  const library = join(await home(), "suits");
  await seedBuiltinSuits(library, await release({ tarn: "v1", mizzle: "v1" }));
  await seedBuiltinSuits(library, await release({ tarn: "v2", mizzle: "v1" }));
  const seeded = await seedBuiltinSuits(library, await release({ tarn: "v3", mizzle: "v2" }));
  expect(seeded.updated).toEqual(["mizzle", "tarn"]);
  expect([await contentOf(library, "tarn"), await contentOf(library, "mizzle")]).toEqual([
    "v3",
    "v2",
  ]);
});

it("a shipped Suit the person edited stays theirs through every later update", async () => {
  const library = join(await home(), "suits");
  await seedBuiltinSuits(library, await release({ tarn: "v1" }));
  await writeFile(join(library, "tarn", "suit.json"), "mine");
  expect((await seedBuiltinSuits(library, await release({ tarn: "v2" }))).updated).toEqual([]);
  // Even once their edit happens to be removed again, ace leaves the folder to them.
  await writeFile(
    join(library, "tarn", "suit.json"),
    JSON.stringify({ id: "tarn", content: "v1" }),
  );
  expect((await seedBuiltinSuits(library, await release({ tarn: "v3" }))).updated).toEqual([]);
  expect(await contentOf(library, "tarn")).toBe("v1");
});

it("a file the system drops into a shipped Suit doesn't stop its update", async () => {
  const library = join(await home(), "suits");
  await seedBuiltinSuits(library, await release({ tarn: "v1" }));
  await writeFile(join(library, "tarn", ".DS_Store"), "finder");
  expect((await seedBuiltinSuits(library, await release({ tarn: "v2" }))).updated).toEqual([
    "tarn",
  ]);
  expect(await contentOf(library, "tarn")).toBe("v2");
});

it("a file or link the person added to a shipped Suit, hidden or not, keeps it theirs", async () => {
  const library = join(await home(), "suits");
  await seedBuiltinSuits(library, await release({ tarn: "v1", mizzle: "v1" }));
  await writeFile(join(library, "tarn", ".notes"), "mine");
  await symlink("suit.json", join(library, "mizzle", "alias.json"));
  const seeded = await seedBuiltinSuits(library, await release({ tarn: "v2", mizzle: "v2" }));
  expect(seeded.updated).toEqual([]);
  expect(await readFile(join(library, "tarn", ".notes"), "utf8")).toBe("mine");
  expect(await readlink(join(library, "mizzle", "alias.json"))).toBe("suit.json");
});

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a first versioned start cut short still never brings back a Suit the person deleted",
  async () => {
    const library = join(await home(), "suits");
    const old = await release({ aaa: "v1", tarn: "v1" });
    await cp(join(old.root, "aaa"), join(library, "aaa"), { recursive: true });
    await writeFile(join(library, ".shipped"), "aaa\ntarn\n");
    // Reading the first Suit fails, so the run stops before it reaches the deleted one.
    await chmod(join(library, "aaa", "suit.json"), 0o000);
    const next = await release({ aaa: "v2", tarn: "v2" });
    await expect(seedBuiltinSuits(library, next)).rejects.toThrow();
    await chmod(join(library, "aaa", "suit.json"), 0o644);
    await seedBuiltinSuits(library, next);
    expect(await suitsIn(library)).toEqual(["aaa"]);
    expect(await contentOf(library, "aaa")).toBe("v2");
  },
);

it("a shipped Suit the person removed is never copied back, even in a new version", async () => {
  const library = join(await home(), "suits");
  await seedBuiltinSuits(library, await release({ tarn: "v1", mizzle: "v1" }));
  await rm(join(library, "tarn"), { recursive: true });
  expect(
    (await seedBuiltinSuits(library, await release({ tarn: "v1", mizzle: "v1" }))).installed,
  ).toEqual([]);
  expect(
    (await seedBuiltinSuits(library, await release({ tarn: "v2", mizzle: "v1" }))).installed,
  ).toEqual([]);
  expect(await suitsIn(library)).toEqual(["mizzle"]);
});

it("a library from a release before versioning gets updates for the copies the person left alone", async () => {
  const library = join(await home(), "suits");
  const old = await release({ tarn: "v1", mizzle: "v1", loam: "v1" });
  for (const id of ["tarn", "mizzle"]) {
    await mkdir(join(library, id), { recursive: true });
    await writeFile(
      join(library, id, "suit.json"),
      await readFile(join(old.root, id, "suit.json")),
    );
  }
  await writeFile(join(library, "mizzle", "suit.json"), "mine");
  // That release listed what it offered; loam is gone because the person removed it.
  await writeFile(join(library, ".shipped"), "loam\nmizzle\ntarn\n");
  const seeded = await seedBuiltinSuits(
    library,
    await release({ tarn: "v2", mizzle: "v2", loam: "v2" }),
  );
  expect(seeded).toEqual({ installed: [], updated: ["tarn"], stale: [] });
  expect(await contentOf(library, "tarn")).toBe("v2");
  expect(await readFile(join(library, "mizzle", "suit.json"), "utf8")).toBe("mine");
  expect(await suitsIn(library)).toEqual(["mizzle", "tarn"]);
});

it("a library left empty by a failed first seed is filled on the next start", async () => {
  const library = join(await home(), "suits");
  const missing = { root: join(await home(), "missing"), lock: join(await home(), "missing") };
  await expect(seedBuiltinSuits(library, missing)).rejects.toThrow();
  expect((await seedBuiltinSuits(library, await release(["tarn"]))).installed).toEqual(["tarn"]);
  expect(await suitsIn(library)).toEqual(["tarn"]);
});

it("an update cut off mid-swap puts the person's Suit back and finishes on the next start", async () => {
  const library = join(await home(), "suits");
  await seedBuiltinSuits(library, await release({ tarn: "v1" }));
  // The old copy was moved aside and the new one never moved in.
  await rename(join(library, "tarn"), join(library, ".replaced-tarn"));
  expect((await seedBuiltinSuits(library, await release({ tarn: "v2" }))).updated).toEqual([
    "tarn",
  ]);
  expect(await contentOf(library, "tarn")).toBe("v2");
  expect(await readdir(library)).not.toContain(".replaced-tarn");
});

it("a shipped Suit whose files don't match the lock is left out and reported", async () => {
  const library = join(await home(), "suits");
  const next = await release({ tarn: "v1", mizzle: "v1" });
  await writeFile(join(next.root, "tarn", "suit.json"), "changed after the lock");
  expect(await seedBuiltinSuits(library, next)).toEqual({
    installed: ["mizzle"],
    updated: [],
    stale: ["tarn"],
  });
  expect(await suitsIn(library)).toEqual(["mizzle"]);
});

it("a folder the person already has under a shipped id is left as they made it", async () => {
  const library = join(await home(), "suits");
  await mkdir(join(library, "tarn"), { recursive: true });
  await writeFile(join(library, "tarn", "suit.json"), "mine");
  expect((await seedBuiltinSuits(library, await release(["tarn"]))).installed).toEqual([]);
  expect(await readFile(join(library, "tarn", "suit.json"), "utf8")).toBe("mine");
});

/** Every file under `folder`, by relative path, with a hash of its bytes. */
async function contents(folder: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path.slice(folder.length + 1)] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  return files;
}

it("a release packs each shipped Suit into one file and seeds the same library as the folders", async () => {
  const packed = join(await home(), "builtin-suits");
  const ids = await packBuiltinSuits(packed);
  // One archive entry per Suit, however many fonts and stills it carries.
  expect((await readdir(packed)).toSorted()).toEqual(ids.map((id) => `${id}.tar`));
  const fromFolders = join(await home(), "suits");
  const fromRelease = join(await home(), "suits");
  expect((await seedBuiltinSuits(fromFolders)).installed).toEqual(ids);
  const lock = new URL("../builtins-lock.json", import.meta.url).pathname;
  expect((await seedBuiltinSuits(fromRelease, { root: packed, lock })).installed).toEqual(ids);
  expect(await contents(fromRelease)).toEqual(await contents(fromFolders));
  expect(Object.keys(await contents(fromRelease))).toContain("palm-haze/scene.js");
});
