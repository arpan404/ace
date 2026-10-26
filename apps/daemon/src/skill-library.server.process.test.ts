import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { ServerMessage, SkillEntry } from "@ace/protocol";
import { createDaemonSkillLibrary, pluginSkillFetcher } from "./skill-library.ts";
import { fixture, type Client } from "./socket-test-support.ts";

const run = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await run("git", args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  return stdout.trim();
}
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
const demo = "---\nname: demo\ndescription: Demo skill\n---\n# Demo\n\nFirst version.\n";

/**
 * A scratch home with one skill installed by the `skills` CLI from a local "GitHub" repo, in
 * `skills/demo` or, with `folder` `.`, at the repository root.
 */
async function setup(folder = "skills/demo") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-skill-socket-")));
  const home = join(root, "home");
  const repo = join(root, "repo");
  await put(join(repo, folder, "SKILL.md"), demo);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "first");
  const folderHash = await git(repo, "rev-parse", `HEAD:${folder === "." ? "" : folder}`);
  await put(join(home, ".agents/skills/demo/SKILL.md"), demo);
  const lock = {
    version: 3,
    skills: {
      demo: {
        source: "acme/skills",
        sourceType: "github",
        sourceUrl: "https://github.com/acme/skills.git",
        skillPath: folder === "." ? "SKILL.md" : `${folder}/SKILL.md`,
        skillFolderHash: folderHash,
        installedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    dismissed: { findSkillsPrompt: true },
  };
  await put(join(home, ".agents/.skill-lock.json"), JSON.stringify(lock, null, 2));
  const real = pluginSkillFetcher();
  let sequence = 0;
  const library = createDaemonSkillLibrary({
    dataDir: join(root, "data"),
    env: {},
    workspace: () => undefined,
    options: {
      homes: {
        home,
        claude: join(home, ".claude"),
        codex: join(home, ".codex"),
        opencode: join(home, ".config/opencode"),
        cursor: join(home, ".cursor"),
        pi: join(home, ".pi/agent"),
      },
      // The lock names GitHub; this test serves the same repository from disk.
      fetcher: { ...real, fetch: (_url, ref, temporary) => real.fetch(repo, ref, temporary) },
    },
    now: () => Date.parse("2026-10-25T00:00:00.000Z"),
    id: () => `id-${++sequence}`,
  });
  const f = await fixture({ skillLibrary: library });
  return {
    root,
    home,
    repo,
    f,
    async close() {
      await f.close();
      await library.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function reply(client: Client, requestId: string): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    if ("requestId" in message && message.requestId === requestId) return message;
  }
}
async function result(client: Client, requestId: string) {
  const message = await reply(client, requestId);
  if (message.type !== "skills.result") throw new Error(JSON.stringify(message));
  return message.result;
}
async function demoEntry(client: Client): Promise<SkillEntry> {
  client.send({
    type: "skills.request",
    requestId: "list",
    operation: { op: "list", subscribe: false },
  });
  const listed = await result(client, "list");
  const entry = listed.kind === "list" ? listed.entries.find((e) => e.name === "demo") : undefined;
  if (!entry) throw new Error(JSON.stringify(listed));
  return entry;
}

test("an installed skill updates from its source after review, and the lock records it", async () => {
  const s = await setup();
  try {
    const client = await s.f.connect();
    await client.next();
    const before = await demoEntry(client);
    expect(before.source).toMatchObject({ source: "acme/skills" });
    client.send({
      type: "skills.request",
      requestId: "check-1",
      operation: { op: "checkUpdate", id: before.id },
    });
    expect(await result(client, "check-1")).toMatchObject({ status: "current" });

    await put(join(s.repo, "skills/demo/SKILL.md"), demo.replace("First", "Second"));
    await put(join(s.repo, "skills/demo/scripts/run.sh"), "#!/bin/sh\necho hi\n");
    await chmod(join(s.repo, "skills/demo/scripts/run.sh"), 0o755);
    await git(s.repo, "add", ".");
    await git(s.repo, "commit", "-q", "-m", "second");
    const nextHash = await git(s.repo, "rev-parse", "HEAD:skills/demo");
    client.send({
      type: "skills.request",
      requestId: "check-2",
      operation: { op: "checkUpdate", id: before.id },
    });
    expect(await result(client, "check-2")).toMatchObject({ status: "available" });
    client.send({
      type: "skills.request",
      requestId: "prepare",
      operation: { op: "prepareUpdate", id: before.id },
    });
    const prepared = await result(client, "prepare");
    if (prepared.kind !== "updateReview") throw new Error(JSON.stringify(prepared));
    expect(prepared.review.files).toEqual([
      { path: "SKILL.md", change: "changed", flagged: false },
      { path: "scripts/run.sh", change: "added", flagged: true },
    ]);
    expect(prepared.review.after).toContain("Second version");
    expect(prepared.review.before).toContain("First version");
    // Nothing on disk changes until the review is applied.
    expect(await readFile(join(s.home, ".agents/skills/demo/SKILL.md"), "utf8")).toBe(demo);

    client.send({
      type: "skills.request",
      requestId: "apply",
      operation: {
        op: "applyUpdate",
        id: before.id,
        reviewId: prepared.review.id,
        expectedHash: prepared.review.baseHash,
      },
    });
    const applied = await result(client, "apply");
    expect(applied).toMatchObject({ kind: "skill", entry: { id: before.id } });
    expect(await readFile(join(s.home, ".agents/skills/demo/SKILL.md"), "utf8")).toContain(
      "Second version",
    );
    expect((await stat(join(s.home, ".agents/skills/demo/scripts/run.sh"))).mode & 0o111).not.toBe(
      0,
    );
    const lock = JSON.parse(await readFile(join(s.home, ".agents/.skill-lock.json"), "utf8"));
    expect(lock.skills.demo).toMatchObject({
      skillFolderHash: nextHash,
      updatedAt: "2026-10-25T00:00:00.000Z",
      installedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(lock.dismissed).toEqual({ findSkillsPrompt: true });
    client.send({
      type: "skills.request",
      requestId: "reapply",
      operation: {
        op: "applyUpdate",
        id: before.id,
        reviewId: prepared.review.id,
        expectedHash: before.hash,
      },
    });
    expect(await result(client, "reapply")).toMatchObject({ kind: "error", code: "not_found" });
  } finally {
    await s.close();
  }
});

test("a skill at the repository root checks and applies updates like a nested one", async () => {
  const s = await setup(".");
  try {
    const client = await s.f.connect();
    await client.next();
    const before = await demoEntry(client);
    expect(before.source).toMatchObject({ path: "SKILL.md" });
    client.send({
      type: "skills.request",
      requestId: "check-1",
      operation: { op: "checkUpdate", id: before.id },
    });
    expect(await result(client, "check-1")).toMatchObject({ status: "current" });
    await put(join(s.repo, "SKILL.md"), demo.replace("First", "Second"));
    await put(join(s.repo, "guide.md"), "More.\n");
    await git(s.repo, "add", ".");
    await git(s.repo, "commit", "-q", "-m", "second");
    client.send({
      type: "skills.request",
      requestId: "prepare",
      operation: { op: "prepareUpdate", id: before.id },
    });
    const prepared = await result(client, "prepare");
    if (prepared.kind !== "updateReview") throw new Error(JSON.stringify(prepared));
    expect(prepared.review.files).toEqual([
      { path: "SKILL.md", change: "changed", flagged: false },
      { path: "guide.md", change: "added", flagged: false },
    ]);
    client.send({
      type: "skills.request",
      requestId: "apply",
      operation: {
        op: "applyUpdate",
        id: before.id,
        reviewId: prepared.review.id,
        expectedHash: prepared.review.baseHash,
      },
    });
    expect(await result(client, "apply")).toMatchObject({ kind: "skill" });
    expect(await readFile(join(s.home, ".agents/skills/demo/guide.md"), "utf8")).toBe("More.\n");
    const lock = JSON.parse(await readFile(join(s.home, ".agents/.skill-lock.json"), "utf8"));
    expect(lock.skills.demo.skillFolderHash).toBe(await git(s.repo, "rev-parse", "HEAD:"));
  } finally {
    await s.close();
  }
});

test("a subscribed list hears about skills created by another client", async () => {
  const s = await setup();
  try {
    const watcher = await s.f.connect();
    await watcher.next();
    watcher.send({
      type: "skills.request",
      requestId: "watch",
      operation: { op: "list", subscribe: true },
    });
    expect(await result(watcher, "watch")).toMatchObject({ kind: "list" });
    const editor = await s.f.connect();
    await editor.next();
    editor.send({
      type: "skills.request",
      requestId: "create",
      operation: {
        op: "create",
        name: "notes",
        description: "Take notes",
        body: "# Notes\n",
        scope: { kind: "personal" },
        agents: ["claude"],
        manual: false,
      },
    });
    expect(await result(editor, "create")).toMatchObject({ kind: "skill" });
    for (;;) {
      const pushed = await reply(watcher, "watch");
      if (pushed.type === "skills.changed" && pushed.entries.some((e) => e.name === "notes")) break;
    }
  } finally {
    await s.close();
  }
});
