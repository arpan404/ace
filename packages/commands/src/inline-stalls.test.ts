import { afterEach, expect, test } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { SkillDisk } from "./skill-disk.ts";
import type { PosixOperation } from "./posix-wire.ts";
import { createSkill, replacePinnedSkill, withSkillFolder } from "./skill-files.ts";
import { skillRootLane } from "./skill-roots.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillResult } from "@ace/protocol";
import { CommandCatalog, CommandFiles, SecureCommandIo, SkillLibrary } from "./index.ts";
import { createHash } from "node:crypto";
import { writeOutcomeUnknown } from "./posix-ops.ts";
import { commandRootSettled, rootLane } from "./posix-calls.ts";
import { useCommandLanes } from "./posix-calls.ts";
import { inlineLanes } from "./posix-inline.ts";

// Real files and real native calls, run inline so one chosen call can block the way a call into
// a dead mount does, until the test lets it return.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const unreadable = "Unreadable skill update journal left in place";
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

test.skipIf(process.platform === "win32")(
  "a skill save whose rename times out says its outcome is unknown, and recovery runs once the folder answers",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-outcome-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const folder = join(home, ".claude/skills/notes");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      "---\nname: notes\ndescription: Notes\n---\n# Notes\n",
    );
    // Every recovery pass reports this unreadable journal, so the reports count the passes.
    const journals = join(root, "journals");
    await mkdir(journals);
    await writeFile(join(journals, "broken.json"), "not json");
    let stall = true;
    const { lanes, release } = inlineLanes(
      (operation) => stall && operation.op === "rename" && operation.toName === "SKILL.md",
      { deadlineMs: 200 },
    );
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => {
      stall = false;
      release();
      restore();
    });
    const reports: string[] = [];
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
          fetch: () => Promise.reject(new Error("No fetches here")),
          treeHash: () => Promise.reject(new Error("No fetches here")),
          extract: () => Promise.reject(new Error("No fetches here")),
        },
        temporaryRoot: join(root, "staging"),
        lockPath: join(root, "skills-lock.json"),
        journalRoot: journals,
        report: (message) => void reports.push(message),
        now: () => 0,
        id: () => `u${++sequence}`,
      },
      id: () => `t${++sequence}`,
    });
    cleanups.push(() => library.close());
    await library.start();
    const passes = () => reports.filter((report) => report === unreadable).length;
    expect(passes()).toBe(1);
    const listed = await library.request({ op: "list", scope: { kind: "personal" } });
    if (listed.kind !== "list") throw new Error(JSON.stringify(listed));
    const notes = listed.entries.find((entry) => entry.name === "notes");
    if (!notes) throw new Error("Missing notes");
    const result: SkillResult = await library.request({
      op: "edit",
      id: notes.id,
      expectedHash: notes.hash,
      description: "Changed",
      body: "# Changed\n",
      manual: false,
    });
    // The rename may still land: the person is told so, not that the save failed.
    expect(result).toMatchObject({ kind: "error", code: "unavailable" });
    expect(result.kind === "error" && result.message).toContain("may or may not have changed");
    expect(passes()).toBe(1);
    // The stuck rename returns and lands; its thread closes what it owns and exits, the folder
    // settles, and recovery runs again.
    stall = false;
    release();
    for (let wait = 0; wait < 100 && passes() < 2; wait++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(passes()).toBe(2);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toContain("Changed");
    expect((await readdir(folder)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")(
  "closing command files during a recovery pass over stalled roots returns at once",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-recovery-close-")));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const roots = [];
    for (let i = 0; i < 3; i++) {
      const path = join(base, `anchor-${i}`, "commands");
      await mkdir(path, { recursive: true });
      await writeFile(join(path, `item-${i}.md`), "Item");
      roots.push({ path, format: "claude" as const, scope: "user" as const, instance: "personal" });
    }
    // Discovery runs normally; then every recovery check blocks, as on a dead mount.
    let stall = false;
    const { lanes, release } = inlineLanes((operation) => stall && operation.op === "lstatPath", {
      deadlineMs: 5000,
    });
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => {
      stall = false;
      release();
      restore();
    });
    const files = new CommandFiles(new CommandCatalog(() => 0), roots, {
      schedule: () => () => {},
      watch: () => () => {},
    });
    await files.start();
    stall = true;
    const pass = files.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closing = performance.now();
    await files.close();
    await pass;
    // Without cancelling recovery's own calls, close waits a deadline for each stalled check.
    expect(performance.now() - closing).toBeLessThan(300);
  },
);

test.skipIf(process.platform === "win32")(
  "a save that may still land blocks saving the same prompt through another anchor",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-overlap-")));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    // ace's home inside a workspace: global and project prompts are the same folder, reached
    // through two anchors, so two lanes.
    const workspace = join(base, "workspace");
    const prompts = join(workspace, ".ace", "prompts");
    await mkdir(prompts, { recursive: true });
    const file = join(prompts, "x.md");
    await writeFile(file, "Original");
    const { lanes, release } = inlineLanes(
      (operation) => operation.op === "rename" && operation.fromName === "prompt-global",
      { deadlineMs: 200 },
    );
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => {
      release();
      restore();
    });
    const global = new SecureCommandIo();
    const project = new SecureCommandIo();
    cleanups.push(async () => {
      await global.close();
      await project.close();
    });
    const globalRoot = {
      path: prompts,
      trustedRoot: join(workspace, ".ace"),
      format: "library" as const,
      scope: "user" as const,
    };
    const projectRoot = { ...globalRoot, trustedRoot: workspace, scope: "workspace" as const };
    // The global save's rename gets stuck and times out: it may still land.
    const timedOut = await global
      .writePrompt(globalRoot, file, "Global", hash("Original"), "prompt-global")
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(writeOutcomeUnknown(timedOut)).toBeDefined();
    // The project save would be overwritten by it, so it is refused rather than told it worked.
    await expect(
      project.writePrompt(projectRoot, file, "Project", hash("Original"), "prompt-project-1"),
    ).rejects.toThrow("hasn't finished");
    expect(await readFile(file, "utf8")).toBe("Original");
    // The stuck rename lands; after that the project saves over it normally.
    release();
    await commandRootSettled(rootLane(prompts));
    expect(await readFile(file, "utf8")).toBe("Global");
    await project.writePrompt(projectRoot, file, "Project", hash("Global"), "prompt-project-2");
    expect(await readFile(file, "utf8")).toBe("Project");
  },
);

test.skipIf(process.platform === "win32")(
  "a skill root reached through a symlink and through its real path shares one lane",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-lane-")));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const real = join(base, "real", "skills");
    await mkdir(join(real, "notes"), { recursive: true });
    await writeFile(join(real, "notes", "SKILL.md"), "Notes");
    await mkdir(join(base, ".claude"));
    await symlink(real, join(base, ".claude", "skills"));
    const root = {
      path: join(base, ".claude", "skills"),
      scope: "personal" as const,
      readers: ["claude" as const],
      linkFor: [],
    };
    const canonical = {
      root,
      name: "notes",
      path: join(root.path, "notes"),
      real: join(real, "notes"),
      link: false,
      rootReal: real,
    };
    let stall = true;
    const { lanes, release } = inlineLanes(
      (operation) => stall && operation.op === "rename" && operation.toName === "SKILL.md",
      { deadlineMs: 200 },
    );
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => {
      stall = false;
      release();
      restore();
    });
    const disk = new SkillDisk();
    // An edit, which reaches the folder by its real path, times out mid-rename.
    const edit = await withSkillFolder(disk, canonical, (_root, folder) =>
      replacePinnedSkill(disk, folder, "Changed", hash("Notes"), "t1", {
        rootReal: real,
        name: "notes",
        lane: skillRootLane(root),
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(writeOutcomeUnknown(edit)).toBeDefined();
    // Creating a skill reaches the same root by its symlinked path: the same lane, so it waits
    // for the stuck rename rather than racing it.
    await expect(createSkill(disk, root, "other", "Other", "t2")).rejects.toThrow(
      "hasn't finished",
    );
    stall = false;
    release();
    await commandRootSettled(skillRootLane(root));
    await createSkill(disk, root, "other", "Other", "t3");
    expect(await readFile(join(real, "other", "SKILL.md"), "utf8")).toBe("Other");
  },
);

test.skipIf(process.platform === "win32")(
  "closing the skill library during a stuck skill call ends its calls at once, and leaves another owner's alone",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-close-")));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const home = join(base, "home");
    const folder = join(home, ".claude/skills/notes");
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "SKILL.md"),
      "---\nname: notes\ndescription: Notes\n---\n# Notes\n",
    );
    let stalled = false;
    const { promise: stuck, resolve: onStall } = Promise.withResolvers<void>();
    const { lanes, release } = inlineLanes(
      (operation) => {
        if (stalled || operation.op !== "rename" || operation.toName !== "SKILL.md") return false;
        stalled = true;
        onStall();
        return true;
      },
      { deadlineMs: 5000 },
    );
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => {
      release();
      restore();
    });
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
      id: () => `t${++sequence}`,
    });
    const listed = await library.request({ op: "list" });
    if (listed.kind !== "list") throw new Error(JSON.stringify(listed));
    const notes = listed.entries.find((entry) => entry.name === "notes");
    if (!notes) throw new Error("Missing notes");
    const editing = library.request({
      op: "edit",
      id: notes.id,
      expectedHash: notes.hash,
      description: "Changed",
      body: "# Changed\n",
      manual: false,
    });
    await stuck;
    // A request queued behind the stuck one, and another owner reading on the same root's lane.
    const queued = library.request({ op: "list" });
    const other = new SecureCommandIo();
    cleanups.push(() => other.close());
    let read: string | undefined;
    const reading = other
      .read(
        {
          path: join(home, ".claude/skills"),
          trustedRoot: join(home, ".claude"),
          format: "claude",
          scope: "user",
          skill: true,
          skillLinkHome: home,
        },
        join(folder, "SKILL.md"),
      )
      .then((data) => (read = data.text));
    const closing = performance.now();
    await library.close();
    const [edited, list] = await Promise.all([editing, queued]);
    expect(performance.now() - closing).toBeLessThan(300);
    // The stuck rename may still land, and the queued request never ran.
    expect(edited).toMatchObject({ kind: "error", code: "unavailable" });
    expect(list).toMatchObject({ kind: "error" });
    // The other owner's read waits its turn behind the stuck rename, untouched by the close.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(read).toBeUndefined();
    release();
    await reading;
    expect(read).toContain("Changed");
  },
);

/** A skill library over `home` whose file calls run on `lanes`. */
function skillLibraryAt(home: string): SkillLibrary {
  let sequence = 0;
  return new SkillLibrary({
    homes: {
      home,
      claude: join(home, ".claude"),
      codex: join(home, ".codex"),
      opencode: join(home, ".config/opencode"),
      cursor: join(home, ".cursor"),
      pi: join(home, ".pi/agent"),
    },
    workspace: () => undefined,
    id: () => `t${++sequence}`,
  });
}

test.skipIf(process.platform === "win32")(
  "closing the skill library during a listing answers unavailable, never a shorter list",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-listing-")));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const home = join(base, "home");
    for (const root of [".agents/skills", ".claude/skills"])
      await put(join(home, root, "notes", "SKILL.md"), "---\nname: notes\ndescription: N\n---\n");
    // The listing's first look at a skill root blocks, as on a dead mount.
    const { promise: stuck, resolve: onStall } = Promise.withResolvers<void>();
    let stalled = false;
    const { lanes, release } = inlineLanes(
      (operation) => {
        if (stalled || operation.op !== "realpath") return false;
        stalled = true;
        onStall();
        return true;
      },
      { deadlineMs: 5000 },
    );
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => {
      release();
      restore();
    });
    const skills = skillLibraryAt(home);
    const listing = skills.request({ op: "list" });
    await stuck;
    await skills.close();
    // Without its cancelled calls the list would be short; it says it couldn't answer instead.
    expect(await listing).toMatchObject({ kind: "error", code: "unavailable" });
  },
);

test.skipIf(process.platform === "win32")(
  "a skill only linked in from outside every root is read on the linking root's lane",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-external-")));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const home = join(base, "home");
    await put(join(base, "mnt", "tools", "SKILL.md"), "---\nname: tools\ndescription: T\n---\n");
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await symlink(join(base, "mnt", "tools"), join(home, ".claude/skills/tools"));
    const { lanes } = inlineLanes(() => false);
    // Which lane each native call names, as the lanes see it.
    const seen: { lane: string; operation: PosixOperation }[] = [];
    const run = lanes.run.bind(lanes);
    lanes.run = (lane, operation, options) => {
      seen.push({ lane, operation });
      return run(lane, operation, options);
    };
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => restore());
    const skills = skillLibraryAt(home);
    cleanups.push(() => skills.close());
    const listed = await skills.request({ op: "list" });
    if (listed.kind !== "list") throw new Error(JSON.stringify(listed));
    expect(listed.entries.map((entry) => entry.name)).toContain("tools");
    const read = seen.find(
      (call) => call.operation.op === "readPathNoFollow" && call.operation.path.includes("tools"),
    );
    expect(read?.lane).toBe(rootLane(join(home, ".claude/skills")));
  },
);

test.skipIf(process.platform === "win32")(
  "a skill create cancelled at close is cleaned up once its late change lands",
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-cleanup-")));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const home = join(base, "home");
    await mkdir(join(home, ".agents/skills"), { recursive: true });
    const { promise: stuck, resolve: onStall } = Promise.withResolvers<void>();
    let stalled = false;
    const { lanes, release } = inlineLanes(
      (operation) => {
        if (stalled || operation.op !== "rename" || operation.toName !== "SKILL.md") return false;
        stalled = true;
        onStall();
        return true;
      },
      { deadlineMs: 5000 },
    );
    const restore = useCommandLanes(lanes);
    cleanups.push(async () => {
      release();
      restore();
    });
    const skills = skillLibraryAt(home);
    const creating = skills.request({
      op: "create",
      name: "drafts",
      description: "Drafts",
      body: "# Drafts\n",
      scope: { kind: "personal" },
      agents: ["codex"],
      manual: false,
    });
    await stuck;
    await skills.close();
    expect(await creating).toMatchObject({ kind: "error", code: "unavailable" });
    expect((await readdir(join(home, ".agents/skills"))).includes("drafts")).toBe(true);
    // The cancelled rename lands; only then is the half-made folder removed, not refused.
    release();
    for (let wait = 0; wait < 100; wait++) {
      if (!(await readdir(join(home, ".agents/skills"))).includes("drafts")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await readdir(join(home, ".agents/skills"))).not.toContain("drafts");
  },
);
