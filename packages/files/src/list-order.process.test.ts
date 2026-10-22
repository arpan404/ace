import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { fixture } from "./test-support.ts";

const Listing = z.object({ paths: z.array(z.string()), truncated: z.boolean() });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function setup() {
  const f = await fixture();
  cleanup.push(() => f.close());
  return f;
}
async function put(root: string, path: string, text = "") {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}

test("a listing cut off by its limit still shows every top-level folder of a deep checkout", async () => {
  const f = await setup();
  // The first folder alone holds far more than the limit, deep down.
  for (let index = 0; index < 40; index++) await put(f.root, `apps/web/src/part-${index}/file.ts`);
  await put(f.root, "docs/guide.md");
  await put(f.root, "packages/client/index.ts");
  await put(f.root, "README.md");
  const listing = Listing.parse(
    await f.service.request("writer", { op: "list", path: "", limit: 10 }),
  );
  expect(listing.truncated).toBe(true);
  expect(listing.paths).toHaveLength(10);
  expect(listing.paths).toEqual(
    expect.arrayContaining(["apps/", "docs/", "packages/", "README.md"]),
  );
  // Nearer levels come first: what the limit dropped is the deepest.
  expect(listing.paths).toEqual(expect.arrayContaining(["apps/web/", "docs/guide.md"]));
});

test("a listing within its limit holds every path, with git's ignored files left out", async () => {
  const f = await setup();
  execFileSync("git", ["init", "-q"], { cwd: f.root });
  await put(f.root, ".gitignore", "build/\n");
  await put(f.root, "app/.gitignore", "*.tmp\n");
  await put(f.root, "app/src/main.ts");
  await put(f.root, "app/src/scratch.tmp");
  await put(f.root, "build/out.js");
  const listing = Listing.parse(
    await f.service.request("writer", { op: "list", path: "", limit: 1000 }),
  );
  expect(listing.truncated).toBe(false);
  expect(listing.paths.toSorted()).toEqual(
    [".gitignore", "app/", "app/.gitignore", "app/src/", "app/src/main.ts"].toSorted(),
  );
});
