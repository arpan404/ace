import { afterEach, expect, test } from "vitest";
import {
  lstat,
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
import { dirname, join } from "node:path";
import type { SkillEntry, SkillResult } from "@ace/protocol";
import { SkillLibrary } from "./index.ts";
import { openCommandChild, type OpenCommandChild } from "./posix.ts";

// Windows links agent folders with directory junctions: symlinks need a privilege ace never asks
// for (ADR 0103, Windows). Every case here runs only on Windows.
const windows = test.runIf(process.platform === "win32");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const skillText = (name: string) =>
  `---\nname: ${name}\ndescription: The ${name} skill\n---\n# ${name}\n\nDo the ${name} work.\n`;
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** A home with `notes` in the shared folder and a folder outside every skill root. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-junction-")));
  const home = join(root, "home");
  const skills = join(home, ".agents", "skills");
  const claudeSkills = join(home, ".claude", "skills");
  const outside = join(root, "outside");
  await put(join(skills, "notes", "SKILL.md"), skillText("notes"));
  await put(join(outside, "SKILL.md"), skillText("notes"));
  await put(join(outside, "keep.md"), "Keep me.\n");
  await mkdir(claudeSkills, { recursive: true });
  let swapArmed = false;
  // The moment ace opens the skill folder, another program moves it and leaves a junction.
  const openChild: OpenCommandChild = async (directory, name, flags) => {
    const fd = await openCommandChild(directory, name, flags);
    if (swapArmed && name === "notes") {
      swapArmed = false;
      await rename(join(skills, "notes"), join(skills, ".moved"));
      await symlink(outside, join(skills, "notes"), "junction");
    }
    return fd;
  };
  let sequence = 0;
  const library = new SkillLibrary({
    homes: {
      home,
      claude: join(home, ".claude"),
      codex: join(home, ".codex"),
      opencode: join(home, ".config", "opencode"),
      cursor: join(home, ".cursor"),
      pi: join(home, ".pi", "agent"),
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
    root,
    home,
    skills,
    claudeSkills,
    outside,
    library,
    swapNext() {
      swapArmed = true;
    },
  };
}
async function named(library: SkillLibrary, name: string): Promise<SkillEntry> {
  const result = await library.request({ op: "list" });
  const entry = result.kind === "list" ? result.entries.find((e) => e.name === name) : undefined;
  if (!entry) throw new Error(`Missing ${name}: ${JSON.stringify(result)}`);
  return entry;
}
function skill(result: SkillResult) {
  if (result.kind !== "skill") throw new Error(JSON.stringify(result));
  return result;
}
const agents = (entry: SkillEntry) => entry.agents.map((a) => `${a.provider}:${a.via}`);
async function outsideFiles(outside: string) {
  const names = (await readdir(outside)).toSorted();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await readFile(join(outside, name), "utf8")]),
    ),
  );
}

windows(
  "Windows skill library creates a skill and links it for Claude through a junction",
  async () => {
    const f = await fixture();
    const created = skill(
      await f.library.request({
        op: "create",
        name: "release-notes",
        description: "Write release notes",
        body: "# Release notes\n\nList what changed.\n",
        scope: { kind: "personal" },
        agents: ["claude", "codex"],
      }),
    );
    const canonical = join(f.skills, "release-notes");
    const link = join(f.claudeSkills, "release-notes");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await realpath(link)).toBe(await realpath(canonical));
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe(created.text);
    expect(agents(created.entry)).toContain("claude:link");

    const unlinked = skill(
      await f.library.request({ op: "setAgents", id: created.entry.id, agents: ["codex"] }),
    );
    expect(agents(unlinked.entry)).not.toContain("claude:link");
    expect(await lstat(link).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(created.text);

    const relinked = skill(
      await f.library.request({ op: "setAgents", id: created.entry.id, agents: ["claude"] }),
    );
    expect(agents(relinked.entry)).toContain("claude:link");
    expect(
      await f.library.request({
        op: "delete",
        id: created.entry.id,
        expectedHash: relinked.entry.hash,
      }),
    ).toMatchObject({ kind: "deleted" });
    expect(await lstat(canonical).catch(() => undefined)).toBeUndefined();
    expect(await lstat(link).catch(() => undefined)).toBeUndefined();
  },
);

windows(
  "Windows skill listing recognises a junction the person made and edits through the shared folder",
  async () => {
    const f = await fixture();
    await symlink(join(f.skills, "notes"), join(f.claudeSkills, "notes"), "junction");
    const notes = await named(f.library, "notes");
    expect(notes).toMatchObject({ editable: true });
    expect(agents(notes)).toContain("claude:link");
    expect(notes.agents.find((a) => a.provider === "claude")?.removable).toBe(true);
    const saved = skill(
      await f.library.request({
        op: "edit",
        id: notes.id,
        expectedHash: notes.hash,
        description: "Take better notes",
        body: "New steps.\n",
        manual: false,
      }),
    );
    expect(await readFile(join(f.claudeSkills, "notes", "SKILL.md"), "utf8")).toBe(saved.text);
    expect(
      await f.library.request({
        op: "edit",
        id: notes.id,
        expectedHash: notes.hash,
        description: "Stale",
        body: "Stale.\n",
        manual: false,
      }),
    ).toMatchObject({ kind: "error", code: "conflict" });
    // Removing Claude takes away the person's junction only, never the folder it points at.
    await f.library.request({ op: "setAgents", id: notes.id, agents: ["codex"] });
    expect(await lstat(join(f.claudeSkills, "notes")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(f.skills, "notes", "SKILL.md"), "utf8")).toBe(saved.text);
  },
);

windows(
  "Windows skill edit raced by a folder-to-junction swap writes nothing outside the skill root",
  async () => {
    const f = await fixture();
    const notes = await named(f.library, "notes");
    f.swapNext();
    await f.library.request({
      op: "edit",
      id: notes.id,
      expectedHash: notes.hash,
      description: "Changed",
      body: "Changed body.\n",
      manual: false,
    });
    expect(await outsideFiles(f.outside)).toEqual({
      "SKILL.md": skillText("notes"),
      "keep.md": "Keep me.\n",
    });
  },
);

windows(
  "Windows skill delete raced by a folder-to-junction swap deletes nothing outside the skill root",
  async () => {
    const f = await fixture();
    const notes = await named(f.library, "notes");
    f.swapNext();
    await f.library.request({ op: "delete", id: notes.id, expectedHash: notes.hash });
    expect(await outsideFiles(f.outside)).toEqual({
      "SKILL.md": skillText("notes"),
      "keep.md": "Keep me.\n",
    });
  },
);
