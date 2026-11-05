import { afterEach, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillResult } from "@ace/protocol";
import { CommandCatalog, CommandFiles, SkillLibrary } from "./index.ts";
import { useCommandLanes } from "./posix-calls.ts";
import { inlineLanes } from "./posix-inline.ts";

// Real files and real native calls, run inline so one chosen call can block the way a call into
// a dead mount does, until the test lets it return.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
const unreadable = "Unreadable skill update journal left in place";

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
