import { afterEach, expect, test } from "vitest";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillEntry, SkillResult, SkillUpdateReview } from "@ace/protocol";
import { SkillLibrary } from "./index.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function put(path: string, text: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
const installedHash = "a".repeat(40);
const upstreamHash = "b".repeat(40);
const v1 = "---\nname: demo\ndescription: Demo\n---\nFirst version.\n";
const v2 = "---\nname: demo\ndescription: Demo\n---\nSecond version.\n";

const lock = (folderHash: string) =>
  JSON.stringify({
    version: 3,
    skills: {
      demo: {
        source: "acme/skills",
        sourceType: "github",
        sourceUrl: "https://github.com/acme/skills.git",
        skillPath: "skills/demo/SKILL.md",
        skillFolderHash: folderHash,
      },
    },
  });

/**
 * `demo` installed by the `skills` CLI at `installedHash`; its source now has `upstreamHash`.
 * The fetcher stands in for Git and serves `upstream` as the source folder.
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-updates-")));
  const home = join(root, "home");
  const skills = join(home, ".agents/skills");
  const upstream = join(root, "upstream");
  const lockPath = join(home, ".agents/.skill-lock.json");
  await put(join(skills, "demo/SKILL.md"), v1);
  await put(join(skills, "demo/notes.md"), "Notes v1.\n");
  await put(join(upstream, "SKILL.md"), v2);
  await put(join(upstream, "notes.md"), "Notes v2.\n");
  await put(lockPath, lock(installedHash));
  let sequence = 0;
  const library = new SkillLibrary({
    homes: {
      home,
      claude: join(home, ".claude"),
      codex: join(home, ".codex"),
      opencode: join(home, ".config/opencode"),
      cursor: join(home, ".cursor"),
      pi: join(home, ".pi/agent"),
    },
    workspace: () => undefined,
    updates: {
      fetcher: {
        fetch: async (_url, _ref, temporary) => ({ gitRoot: temporary, commit: "c".repeat(40) }),
        treeHash: async () => upstreamHash,
        extract: async (_gitRoot, _commit, _folder, destination) =>
          cp(upstream, destination, { recursive: true }),
      },
      temporaryRoot: join(root, "data/skill-updates"),
      lockPath,
      now: () => Date.parse("2026-10-25T00:00:00.000Z"),
      id: () => `t${++sequence}`,
    },
    id: () => `w${++sequence}`,
  });
  cleanups.push(async () => {
    await chmod(join(home, ".agents"), 0o755).catch(() => {});
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  /** Everything in the skill's root folder, hidden entries included, with file contents. */
  const folder = async () => {
    const out: Record<string, string> = {};
    const visit = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await visit(join(directory, entry.name), `${path}/`);
        else out[path] = await readFile(join(directory, entry.name), "utf8");
      }
    };
    await visit(skills, "");
    return out;
  };
  return { home, skills, lockPath, lock, library, folder };
}
async function demo(library: SkillLibrary): Promise<SkillEntry> {
  const result = await library.request({ op: "list" });
  const entry = result.kind === "list" ? result.entries.find((e) => e.name === "demo") : undefined;
  if (!entry) throw new Error(JSON.stringify(result));
  return entry;
}
async function prepare(library: SkillLibrary, entry: SkillEntry): Promise<SkillUpdateReview> {
  const result = await library.request({ op: "prepareUpdate", id: entry.id });
  if (result.kind !== "updateReview") throw new Error(JSON.stringify(result));
  return result.review;
}
const apply = (library: SkillLibrary, entry: SkillEntry, review: SkillUpdateReview) =>
  library.request({
    op: "applyUpdate",
    id: entry.id,
    reviewId: review.id,
    expectedHash: review.baseHash,
  });
const errorCode = (result: SkillResult) => (result.kind === "error" ? result.code : result.kind);
const installed = { "demo/SKILL.md": v1, "demo/notes.md": "Notes v1.\n" };

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
  // The lock stays readable but its folder refuses the replacement file.
  await chmod(join(f.home, ".agents"), 0o555);
  const result = await apply(f.library, entry, review);
  await chmod(join(f.home, ".agents"), 0o755);
  expect(errorCode(result)).toBe("update_failed");
  expect(result.kind === "error" && result.message).toContain("skills lock file");
  expect(await f.folder()).toEqual(installed);
  expect(await readFile(f.lockPath, "utf8")).toBe(f.lock(installedHash));
});

test("a restart after a crash mid-update rolls back unless the lock recorded the new version", async () => {
  // Crashed after the swap, before the lock write: the backup holds the original.
  const f = await fixture();
  await put(join(f.skills, "demo/SKILL.md"), v2);
  await rm(join(f.skills, "demo/notes.md"));
  await put(join(f.skills, `.demo.ace-old-${upstreamHash}-t1/SKILL.md`), v1);
  await put(join(f.skills, `.demo.ace-old-${upstreamHash}-t1/notes.md`), "Notes v1.\n");
  await put(join(f.skills, ".demo.ace-update-t2/SKILL.md"), "half-built");
  await f.library.start();
  expect(await f.folder()).toEqual(installed);

  // Crashed after the lock write, before the backup was removed: the update stands.
  const g = await fixture();
  await put(g.lockPath, g.lock(upstreamHash));
  await put(join(g.skills, "demo/SKILL.md"), v2);
  await put(join(g.skills, `.demo.ace-old-${upstreamHash}-t1/SKILL.md`), v1);
  await g.library.start();
  expect(await g.folder()).toEqual({ "demo/SKILL.md": v2, "demo/notes.md": "Notes v1.\n" });
});

test("an installed folder over the size limit can't be reviewed, with a one-line reason", async () => {
  const f = await fixture();
  await put(join(f.skills, "demo/model.bin"), Buffer.alloc(5 * 1024 * 1024));
  const entry = await demo(f.library);
  const result = await f.library.request({ op: "prepareUpdate", id: entry.id });
  expect(errorCode(result)).toBe("limit");
  expect(result.kind === "error" && result.message).toMatch(/^[^\n]+ MB\.$/);
});
