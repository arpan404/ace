import { afterEach, expect, test } from "vitest";
import { constants, fstatSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  lstat,
  readdir,
  readlink,
  realpath,
  stat,
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
async function fixture(options: { claudeLink?: boolean } = {}) {
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
  const claudeSkills = join(home, ".claude/skills");
  await mkdir(claudeSkills, { recursive: true });
  if (options.claudeLink) await symlink("../../.agents/skills/notes", join(claudeSkills, "notes"));
  // Outside, an entry named like the link that also resolves to the skill.
  const outsideLinks = join(root, "outside-links");
  await mkdir(outsideLinks);
  await symlink(join(skills, "notes"), join(outsideLinks, "notes"));
  let armed = false;
  let armedRoot: { ino: number } | undefined;
  const openChild: OpenCommandChild = async (directory, name, flags) => {
    const fd = await openCommandChild(directory, name, flags);
    if (armed && name === "notes" && (flags & constants.O_DIRECTORY) !== 0) {
      armed = false;
      await rename(join(skills, "notes"), join(skills, ".moved"));
      await symlink(outside, join(skills, "notes"));
    }
    if (armedRoot && fstatSync(fd).ino === armedRoot.ino) {
      // Right after ace pins Claude's skill folder, it becomes a symlink to the outside folder.
      armedRoot = undefined;
      await rename(claudeSkills, join(home, ".claude/moved"));
      await symlink(outsideLinks, claudeSkills);
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
    home,
    outsideLinks,
    async swapLinkRootNext() {
      armedRoot = { ino: (await stat(claudeSkills)).ino };
    },
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

const allButClaude = ["codex", "opencode", "cursor", "pi"] as const;

test("removing an agent raced by a link-root swap removes nothing outside the root", async () => {
  const f = await fixture({ claudeLink: true });
  const entry = await notes(f.library);
  expect(entry.agents.some((agent) => agent.provider === "claude" && agent.via === "link")).toBe(
    true,
  );
  await f.swapLinkRootNext();
  await f.library.request({ op: "setAgents", id: entry.id, agents: [...allButClaude] });
  expect((await lstat(join(f.outsideLinks, "notes"))).isSymbolicLink()).toBe(true);
  // The removal happened in the folder ace pinned, which was moved aside.
  await expect(lstat(join(f.home, ".claude/moved/notes"))).rejects.toThrow();
});

test("adding an agent raced by a link-root swap links nothing outside the root", async () => {
  const f = await fixture();
  await rm(join(f.outsideLinks, "notes"));
  const entry = await notes(f.library);
  await f.swapLinkRootNext();
  const result = await f.library.request({
    op: "setAgents",
    id: entry.id,
    agents: [...allButClaude, "claude"],
  });
  expect(await readdir(f.outsideLinks)).toEqual([]);
  // The link landed in the pinned folder; the check afterwards saw the swap and took it back.
  expect(result.kind).toBe("error");
  expect(await readdir(join(f.home, ".claude/moved"))).toEqual([]);
});

test("without a race, agents are linked and unlinked in Claude's folder", async () => {
  const f = await fixture();
  const entry = await notes(f.library);
  const linked = await f.library.request({
    op: "setAgents",
    id: entry.id,
    agents: [...allButClaude, "claude"],
  });
  expect(linked.kind).toBe("skill");
  expect(await readlink(join(f.home, ".claude/skills/notes"))).toBe("../../.agents/skills/notes");
  await f.library.request({ op: "setAgents", id: entry.id, agents: [...allButClaude] });
  await expect(lstat(join(f.home, ".claude/skills/notes"))).rejects.toThrow();
});
