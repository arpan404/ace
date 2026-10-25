import { afterEach, expect, test } from "vitest";
import { constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillEntry } from "@ace/protocol";
import { SkillLibrary } from "./index.ts";
import { openCommandChild, type OpenCommandChild } from "./posix.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const original = "---\nname: notes\ndescription: Take notes\n---\nWrite it down.\n";
// The decoy copies SKILL.md, so a hash check alone can't tell it from the real folder.
const decoy = original;

/**
 * A personal skill `notes` and a folder outside every skill root. `swapNext()` arms a race: the
 * moment ace opens the skill folder, another process renames it away and leaves a symlink to the
 * outside folder in its place.
 */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-swap-")));
  const home = join(root, "home");
  const skills = join(home, ".agents/skills");
  const outside = join(root, "outside");
  await mkdir(join(skills, "notes"), { recursive: true });
  await writeFile(join(skills, "notes/SKILL.md"), original);
  await writeFile(join(skills, "notes/extra.md"), "More.\n");
  await mkdir(outside);
  await writeFile(join(outside, "SKILL.md"), decoy);
  await writeFile(join(outside, "keep.md"), "Keep me.\n");
  let armed = false;
  const openChild: OpenCommandChild = async (directory, name, flags) => {
    const fd = await openCommandChild(directory, name, flags);
    if (armed && name === "notes" && (flags & constants.O_DIRECTORY) !== 0) {
      armed = false;
      await rename(join(skills, "notes"), join(skills, ".moved"));
      await symlink(outside, join(skills, "notes"));
    }
    return fd;
  };
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
    openChild,
    id: () => `t${++sequence}`,
  });
  cleanups.push(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    library,
    outside,
    swapNext() {
      armed = true;
    },
  };
}
async function notes(library: SkillLibrary): Promise<SkillEntry> {
  const result = await library.request({ op: "list" });
  const entry = result.kind === "list" ? result.entries.find((e) => e.name === "notes") : undefined;
  if (!entry) throw new Error(JSON.stringify(result));
  return entry;
}
async function outsideFiles(outside: string) {
  const names = (await readdir(outside)).toSorted();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(outside, name), "utf8")]),
    ),
  );
}

test("an edit raced by a folder-to-symlink swap writes nothing outside the skill root", async () => {
  const f = await fixture();
  const entry = await notes(f.library);
  f.swapNext();
  await f.library.request({
    op: "edit",
    id: entry.id,
    expectedHash: entry.hash,
    description: "Changed",
    body: "Changed body.\n",
    manual: false,
  });
  expect(await outsideFiles(f.outside)).toEqual({ "SKILL.md": decoy, "keep.md": "Keep me.\n" });
});

test("a delete raced by a folder-to-symlink swap deletes nothing outside the skill root", async () => {
  const f = await fixture();
  const entry = await notes(f.library);
  f.swapNext();
  await f.library.request({ op: "delete", id: entry.id, expectedHash: entry.hash });
  expect(await outsideFiles(f.outside)).toEqual({ "SKILL.md": decoy, "keep.md": "Keep me.\n" });
});

test("without a race, edit and delete still change the skill", async () => {
  const f = await fixture();
  const entry = await notes(f.library);
  const edited = await f.library.request({
    op: "edit",
    id: entry.id,
    expectedHash: entry.hash,
    description: "Changed",
    body: "Changed body.\n",
    manual: false,
  });
  if (edited.kind !== "skill") throw new Error(JSON.stringify(edited));
  expect(edited.text).toContain("Changed body.");
  const deleted = await f.library.request({
    op: "delete",
    id: entry.id,
    expectedHash: edited.entry.hash,
  });
  expect(deleted).toEqual({ kind: "deleted", id: entry.id });
  const listed = await f.library.request({ op: "list" });
  expect(listed.kind === "list" && listed.entries.some((e) => e.name === "notes")).toBe(false);
});
