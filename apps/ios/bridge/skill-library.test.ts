import "./test-host.ts";
import { afterEach, expect, test } from "vitest";
import { NativeReads } from "./native-reads.ts";
import { NativeServices } from "./native-services.ts";
import { RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";
import { NativeSkillLibrary, NativeSkillsRequest } from "./skill-library.ts";

/* The phone's skill library on the fake daemon's skills (ADR 0103). */

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

type Reply = Record<string, unknown> & { ok: boolean };
async function library() {
  const { daemon, client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const skills = new NativeSkillLibrary(client, () => Date.parse("2026-10-27T12:00:00Z"));
  const ask = async (request: Record<string, unknown>) =>
    (await skills.answer(
      NativeSkillsRequest.parse({ type: "skills.native", ...request }),
      new AbortController().signal,
    )) as Reply;
  const groups = async (workspaceId?: string) => {
    const reply = (await ask({ op: "library", workspaceId, project: "ace" })) as Reply & {
      groups: { title: string; rows: { id: string; name: string }[] }[];
    };
    return reply.groups;
  };
  const named = async (name: string, workspaceId?: string) =>
    (await groups(workspaceId)).flatMap((group) => group.rows).filter((row) => row.name === name);
  return { daemon, ask, groups, named };
}

const draft = {
  op: "create",
  name: "release-notes",
  description: "Write the release notes",
  body: "# Release notes\n\nList what changed.\n",
  scope: "personal",
  agents: ["claude", "codex"],
  manual: false,
};

test("skills are grouped by where they live, the project's first and ace's own last", async () => {
  const { groups } = await library();
  // Plugin skills are on their plugin's page, not in the library list.
  expect((await groups("project")).map((group) => group.title)).toEqual([
    "ace project",
    "Personal",
    "Built into ace",
  ]);
  expect((await groups()).map((group) => group.title)).not.toContain("ace project");
});

test("a new skill is listed once created, and its name is then taken in that scope only", async () => {
  const { ask, named } = await library();
  const created = await ask(draft);
  expect(created).toMatchObject({ ok: true });
  expect(await named("release-notes")).toEqual([expect.objectContaining({ id: created.id })]);
  expect(await ask({ op: "check", name: "release-notes", scope: "personal" })).toMatchObject({
    problem: "You already have a skill called release-notes.",
  });
  expect(await ask({ op: "check", name: "Release Notes", scope: "personal" })).toMatchObject({
    problem: "Use lowercase letters, digits and dashes.",
  });
  expect(await ask({ op: "check", name: "", scope: "project" })).toEqual({
    ok: true,
    problem: null,
    path: ".agents/skills/name/SKILL.md",
  });
});

test("a create sent again after its answer was lost makes one skill and says it was made", async () => {
  const { ask, named } = await library();
  const first = await ask(draft);
  // The phone never heard `first`, so it sends the same create again.
  const again = await ask({ ...draft, retry: true });
  expect(again).toEqual({ ok: true, id: first.id });
  expect(await named("release-notes")).toHaveLength(1);
});

test("a retried create still refuses a name another skill already holds", async () => {
  const { ask } = await library();
  const clash = await ask({ ...draft, name: "research", retry: true });
  expect(clash).toMatchObject({ ok: false, code: "exists" });
});

test("an edit sent again after it applied is saved once; someone else's change is a conflict", async () => {
  const { ask } = await library();
  const { id } = await ask(draft);
  const page = await ask({ op: "skill", id });
  const edit = {
    op: "edit",
    id,
    expectedHash: page.hash,
    description: "Write the release notes for a tag",
    body: "# Release notes\n\nList what changed, newest first.\n",
    manual: true,
  };
  const saved = await ask(edit);
  expect(saved).toMatchObject({ ok: true });
  expect(await ask(edit)).toEqual({ ok: true, hash: saved.hash });
  const after = await ask({ op: "skill", id });
  expect(after).toMatchObject({
    description: "Write the release notes for a tag",
    manual: true,
    instructions: "List what changed, newest first.\n",
  });
  expect(await ask({ ...edit, body: "Something else" })).toMatchObject({
    ok: false,
    code: "conflict",
  });
});

test("a delete sent again after it applied reads as deleted, and the skill is gone", async () => {
  const { ask, named } = await library();
  const { id } = await ask(draft);
  const page = await ask({ op: "skill", id });
  expect(await ask({ op: "delete", id, expectedHash: page.hash })).toEqual({
    ok: true,
    deleted: id,
  });
  expect(await ask({ op: "delete", id, expectedHash: page.hash, retry: true })).toEqual({
    ok: true,
    deleted: id,
  });
  expect(await named("release-notes")).toEqual([]);
  expect(await ask({ op: "delete", id, expectedHash: page.hash })).toMatchObject({
    ok: false,
    code: "not_found",
  });
});

test("a skill's page names who loads it, where it lives and when it runs", async () => {
  const { ask, named } = await library();
  const [row] = await named("release-desktop", "project");
  const page = await ask({ op: "skill", id: row?.id, workspaceId: "project", project: "ace" });
  expect(page).toMatchObject({
    title: "Release desktop",
    savedIn: "ace project",
    path: ".claude/skills/release-desktop",
    runs: "Claude Code and Cursor never load it by themselves. Codex and OpenCode may still load it.",
    used: "6 times",
    argumentHint: "[version]",
    open: { workspaceId: "project", path: ".claude/skills/release-desktop/SKILL.md" },
  });
  const agents = page.agents as { id: string; on: boolean; locked: boolean }[];
  expect(agents.filter((agent) => agent.on).map((agent) => agent.id)).toEqual([
    "claude",
    "codex",
    "opencode",
    "cursor",
  ]);
  expect(agents.find((agent) => agent.id === "claude")).toMatchObject({ locked: true });
  expect(agents.find((agent) => agent.id === "codex")).toMatchObject({ locked: false });
});

test("removing an agent that reads the skill's own folder says it still sees the skill", async () => {
  const { ask, named } = await library();
  const [row] = await named("research");
  const reply = await ask({ op: "agents", id: row?.id, agents: [] });
  expect(reply).toMatchObject({
    ok: true,
    note: "Codex, OpenCode, Cursor and Pi still see Research. It reads the folder the skill is saved in.",
  });
  const page = await ask({ op: "skill", id: row?.id });
  const agents = page.agents as { id: string; on: boolean }[];
  expect(agents.find((agent) => agent.id === "claude")?.on).toBe(false);
});

test("a built-in skill can't be changed from the phone", async () => {
  const { ask, named } = await library();
  const [row] = await named("review-changes");
  const page = await ask({ op: "skill", id: row?.id });
  expect(page).toMatchObject({ editable: false, path: null });
  expect(await ask({ op: "delete", id: row?.id, expectedHash: page.hash })).toMatchObject({
    ok: false,
    code: "read_only",
  });
});

test("the phone's kept list is read again after it creates a skill, and then shows it", async () => {
  const { client } = sheetFixture();
  close = () => client.close();
  await client.start();
  await until(() => client.connectionState().getSnapshot() === "ready", "connected");
  const sink = new RecordingSink();
  const reads = new NativeReads(client, sink, { now: () => 0, schedule: () => () => {} });
  const services = new NativeServices(
    client,
    sink,
    undefined,
    undefined,
    undefined,
    undefined,
    reads,
  );
  const list = { type: "skills.native", op: "library" };
  const names = (id: string) => {
    const value = sink.read(`service:${id}`)?.value as
      | { groups: { rows: { name: string }[] }[] }
      | undefined;
    return value?.groups.flatMap((group) => group.rows.map((row) => row.name)) ?? [];
  };
  services.handle({ type: "service", id: "before", request: list, cache: "skills" });
  await until(() => sink.read("service:before") !== undefined, "listed");
  expect(names("before")).not.toContain("release-notes");
  services.handle({ type: "service", id: "create", request: { type: "skills.native", ...draft } });
  await until(() => sink.read("service:create") !== undefined, "created");
  expect(sink.read("service:generations")).toMatchObject({ generations: { skills: 1 } });
  services.handle({ type: "service", id: "after", request: list, cache: "skills" });
  await until(() => sink.read("service:after") !== undefined, "listed again");
  expect(names("after")).toContain("release-notes");
});

test("a project skill opens its SKILL.md on the computer through host.open", async () => {
  const { daemon, ask, named } = await library();
  daemon.workspace.setEditors([{ id: "code", name: "VS Code", command: "/usr/local/bin/code" }]);
  const [row] = await named("release-desktop", "project");
  const page = await ask({ op: "skill", id: row?.id, workspaceId: "project" });
  expect(page.open).toEqual({
    workspaceId: "project",
    path: ".claude/skills/release-desktop/SKILL.md",
  });
  expect(await ask({ op: "openers", id: row?.id, workspaceId: "project" })).toEqual({
    ok: true,
    editors: [{ id: "code", name: "VS Code" }],
    fileManager: "Finder",
  });
  const opened = await ask({
    op: "open",
    id: row?.id,
    workspaceId: "project",
    app: { kind: "editor", editorId: "code" },
  });
  expect(opened).toEqual({ ok: true });
  expect(daemon.workspace.opened).toEqual([
    { app: "code", folder: "project", path: ".claude/skills/release-desktop/SKILL.md" },
  ]);
});

test("a personal skill offers no Open on computer and opens nothing", async () => {
  const { daemon, ask, named } = await library();
  const [row] = await named("research");
  expect((await ask({ op: "skill", id: row?.id })).open).toBeNull();
  expect(await ask({ op: "open", id: row?.id, app: { kind: "files" } })).toMatchObject({
    ok: false,
    code: "unavailable",
  });
  expect(daemon.workspace.opened).toEqual([]);
});
