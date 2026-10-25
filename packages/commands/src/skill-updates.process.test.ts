import { afterEach, expect, test } from "vitest";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withSkillLock } from "./skill-lock.ts";
import {
  apply,
  demo,
  errorCode,
  installed,
  installedHash,
  lock,
  prepare,
  put,
  updateHome,
  upstreamHash,
  v1,
  v2,
} from "./skill-update-fixture.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const home = await updateHome();
  cleanups.push(home.close);
  return { ...home, library: home.library(), lock };
}

test("a reviewed update replaces the folder and records the new hash in the lock", async () => {
  const f = await fixture();
  const entry = await demo(f.library);
  const review = await prepare(f.library, entry);
  expect(review.files).toEqual([
    { path: "SKILL.md", change: "changed", flagged: false },
    { path: "notes.md", change: "changed", flagged: false },
  ]);
  expect(errorCode(await apply(f.library, entry, review))).toBe("skill");
  expect(await f.folder()).toEqual({ "demo/SKILL.md": v2, "demo/notes.md": "Notes v2.\n" });
  expect(JSON.parse(await readFile(f.lockPath, "utf8")).skills.demo.skillFolderHash).toBe(
    upstreamHash,
  );
});

test("an auxiliary file edited after the review makes applying it a conflict that changes nothing", async () => {
  const f = await fixture();
  const entry = await demo(f.library);
  const review = await prepare(f.library, entry);
  await writeFile(join(f.skills, "demo/notes.md"), "My own notes.\n");
  expect(errorCode(await apply(f.library, entry, review))).toBe("conflict");
  expect(await f.folder()).toEqual({ ...installed, "demo/notes.md": "My own notes.\n" });
  expect(await readFile(f.lockPath, "utf8")).toBe(f.lock(installedHash));
});

test("a SKILL.md edited after the review is kept even when the caller sends the newer hash", async () => {
  const f = await fixture();
  const entry = await demo(f.library);
  const review = await prepare(f.library, entry);
  const edited = v1.replace("First", "Edited");
  await writeFile(join(f.skills, "demo/SKILL.md"), edited);
  const latest = await demo(f.library);
  const result = await f.library.request({
    op: "applyUpdate",
    id: entry.id,
    reviewId: review.id,
    expectedHash: latest.hash,
  });
  expect(errorCode(result)).toBe("conflict");
  expect(errorCode(await apply(f.library, entry, review))).toBe("conflict");
  expect(await f.folder()).toEqual({ ...installed, "demo/SKILL.md": edited });
});

test("when the lock can't be written the original folder is put back and the lock is unchanged", async () => {
  const f = await fixture();
  const entry = await demo(f.library);
  const review = await prepare(f.library, entry);
  // ace's skills lock already exists there (any earlier update makes it). The lock file stays
  // readable but its folder refuses the replacement file.
  await writeFile(join(f.home, ".agents/.ace-skills.sqlite"), "");
  await chmod(join(f.home, ".agents"), 0o555);
  const result = await apply(f.library, entry, review);
  await chmod(join(f.home, ".agents"), 0o755);
  expect(errorCode(result)).toBe("update_failed");
  expect(result.kind === "error" && result.message).toContain("skills lock file");
  expect(await f.folder()).toEqual(installed);
  expect(await readFile(f.lockPath, "utf8")).toBe(f.lock(installedHash));
});

test("an installed folder over the size limit can't be reviewed, with a one-line reason", async () => {
  const f = await fixture();
  await put(join(f.skills, "demo/model.bin"), Buffer.alloc(5 * 1024 * 1024));
  const entry = await demo(f.library);
  const result = await f.library.request({ op: "prepareUpdate", id: entry.id });
  expect(errorCode(result)).toBe("limit");
  expect(result.kind === "error" && result.message).toMatch(/^[^\n]+ MB\.$/);
});

test("the skills lock makes ~/.agents itself when it's missing", async () => {
  const f = await fixture();
  const agents = join(f.root, "elsewhere/.agents");
  await mkdir(dirname(agents));
  await withSkillLock(
    join(agents, ".ace-skills.sqlite"),
    async () => {},
    async () => {},
  );
  expect((await stat(agents)).mode & 0o777).toBe(0o755 & ~process.umask());
  await expect(
    withSkillLock(
      join(f.root, "missing/parent/.agents/.ace-skills.sqlite"),
      async () => {},
      async () => {},
    ),
  ).rejects.toThrow();
});
