import { afterEach, expect, test } from "vitest";
import { mkdtemp, mkdir, writeFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { CommandLibrary, type ProviderInstance } from "./index.ts";
import type { CatalogEntry, ProviderKind } from "@ace/protocol";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function put(path: string, body: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
}
async function fixture(
  provider: ProviderKind,
  extras?: (context: import("./types.ts").LibraryContext) => Promise<CatalogEntry[]>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-extension-catalog-")));
  const home = join(root, "provider"),
    project = join(root, "project"),
    ace = join(root, "ace");
  await Promise.all([mkdir(home), mkdir(project), mkdir(ace)]);
  const instance: ProviderInstance = { id: "chosen-account", provider, home, skillsHome: root };
  const library = new CommandLibrary({
    aceHome: ace,
    instances: [instance],
    context: () => ({ workspace: project, provider, instance: instance.id }),
    now: () => 1000,
    ...(extras ? { extras } : {}),
  });
  cleanups.push(async () => {
    await library.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, project, library, put };
}
function waitFor(library: CommandLibrary, predicate: (entries: CatalogEntry[]) => boolean) {
  return new Promise<CatalogEntry[]>((resolve, reject) => {
    let running = false,
      dirty = false;
    const read = async () => {
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      try {
        do {
          dirty = false;
          const result = await library.listCatalog("thread", "", 512);
          if (!result.stale && predicate(result.entries)) {
            stop();
            resolve(result.entries);
            return;
          }
        } while (dirty);
      } catch (error) {
        stop();
        reject(error);
      } finally {
        running = false;
      }
    };
    const stop = library.subscribeCatalog(() => {
      void read();
    });
    void read();
  });
}
for (const provider of ["claude", "codex", "opencode", "cursor", "pi"] as const) {
  test(`${provider} discovers global and project skills and uses its harness precedence`, async () => {
    const f = await fixture(provider);
    await f.put(
      join(f.home, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Global review\n---\nGlobal instructions",
    );
    await f.put(
      join(f.project, `.${provider}/skills/review/SKILL.md`),
      "---\nname: review\ndescription: Project review\n---\nProject instructions",
    );
    const entries = await waitFor(f.library, (items) =>
      items.some(
        (e) => e.description === (provider === "claude" ? "Global review" : "Project review"),
      ),
    );
    const description = provider === "claude" ? "Global review" : "Project review";
    expect(entries.filter((e) => e.name === "review" && e.kind === "skill")).toMatchObject([
      { description, source: { provider, scope: provider === "claude" ? "global" : "project" } },
    ]);
    expect(entries.filter((e) => e.name === "review" && e.kind === "skill")).toHaveLength(1);
  });
}
test("Claude skills beat legacy commands and file changes push a replacement without rereading a client path", async () => {
  const f = await fixture("claude");
  await f.put(
    join(f.project, ".claude/commands/review.md"),
    "---\ndescription: Legacy command\n---\nLegacy",
  );
  const file = join(f.project, ".claude/skills/review/SKILL.md");
  await f.put(file, "---\nname: review\ndescription: First skill\n---\nOne");
  const first = await waitFor(f.library, (entries) =>
    entries.some((e) => e.description === "First skill"),
  );
  expect(first.some((e) => e.description === "Legacy command")).toBe(false);
  const changed = waitFor(f.library, (entries) =>
    entries.some((e) => e.description === "Changed skill"),
  );
  await writeFile(file, "---\nname: review\ndescription: Changed skill\n---\nTwo");
  expect((await changed).find((e) => e.name === "review" && e.kind === "skill")?.description).toBe(
    "Changed skill",
  );
});
test("Codex discovers shared Agent Skills, custom prompts and TOML subagents without reading auth files", async () => {
  const f = await fixture("codex");
  await f.put(
    join(f.project, ".agents/skills/summarize/SKILL.md"),
    "---\nname: summarize\ndescription: Summarize project changes\n---\nBody",
  );
  await f.put(
    join(f.home, "prompts/explain.md"),
    "---\ndescription: Explain code\n---\nExplain $ARGUMENTS",
  );
  await f.put(
    join(f.project, ".codex/agents/audit.toml"),
    'name = "audit"\ndescription = "Audit changes"\ndeveloper_instructions = "Synthetic agent"\n',
  );
  await f.put(join(f.home, "auth.json"), "malformed and never parsed");
  const entries = await waitFor(f.library, (items) => items.some((e) => e.name === "audit"));
  expect(entries.find((e) => e.name === "summarize")).toMatchObject({
    kind: "skill",
    invocation: { type: "skill", path: join(f.project, ".agents/skills/summarize/SKILL.md") },
  });
  const prompt = entries.find((e) => e.name === "explain");
  if (!prompt) throw new Error("Missing prompt");
  expect(
    await f.library.prepareMentions("thread", [
      { type: "text", text: "Please " },
      {
        type: "mention",
        entryId: prompt.id,
        name: "explain",
        kind: "command",
        arguments: "the parser",
      },
    ]),
  ).toEqual([{ type: "text", text: "Please Explain the parser" }]);
});
test("OpenCode config agents and commands retain their own kinds and project descriptions", async () => {
  const f = await fixture("opencode");
  await f.put(
    join(f.project, "opencode.jsonc"),
    '{ "agent": { "auditor": { "description": "Project auditor", "prompt": "Review" } }, "command": { "check": { "description": "Project check", "template": "Check", "agent": "auditor", "subtask": true } } }',
  );
  const entries = await waitFor(f.library, (items) => items.some((e) => e.name === "auditor"));
  expect(entries.find((e) => e.name === "auditor")).toMatchObject({
    kind: "agent",
    source: { scope: "project" },
    invocation: { type: "agent", name: "auditor" },
  });
  const command = entries.find((e) => e.name === "check");
  if (!command) throw new Error("Missing command");
  expect(await f.library.resolve("thread", command.id, {}, [])).toMatchObject({
    ok: true,
    plan: { metadata: { agent: "auditor", subtask: true } },
  });
});
test("cached snapshots stay scoped to the selected account", async () => {
  const f = await fixture("claude");
  await f.put(
    join(f.home, "commands/private.md"),
    "---\ndescription: Chosen account only\n---\nBody",
  );
  const first = await waitFor(f.library, (items) => items.some((e) => e.name === "private"));
  expect((await f.library.listCatalog("thread", "private", 10)).entries).toEqual(
    first.filter((e) => e.name === "private"),
  );
  expect(
    (
      await f.library.listCatalogDraft(
        "draft",
        { workspace: f.project, provider: "claude", instance: "removed-account" },
        "private",
        10,
      )
    ).entries,
  ).toEqual([]);
});

test("a cold catalog returns a stale snapshot before its harness metadata is ready and pushes the completed snapshot", async () => {
  const metadata = Promise.withResolvers<CatalogEntry[]>();
  const f = await fixture("codex", () => metadata.promise);
  const first = await f.library.listCatalog("thread", "", 512);
  expect(first.stale).toBe(true);
  expect(first.entries.some((e) => e.name === "Drive")).toBe(false);
  const complete = waitFor(f.library, (entries) => entries.some((e) => e.name === "Drive"));
  metadata.resolve([
    {
      id: "drive",
      kind: "plugin",
      name: "Drive",
      description: "Find docs",
      source: { provider: "codex", scope: "plugin" },
      invocation: { type: "mention", name: "Drive", path: "app://fixture-drive" },
    },
  ]);
  expect((await complete).find((e) => e.name === "Drive")).toMatchObject({
    invocation: { path: "app://fixture-drive" },
  });
});

test("harness skill updates disable disk fallback and clearing one session preserves another session's catalog", async () => {
  const f = await fixture("codex");
  const file = join(f.home, "skills/review/SKILL.md");
  await f.put(file, "---\nname: review\ndescription: Disk review\n---\nBody");
  await waitFor(f.library, (entries) => entries.some((e) => e.description === "Disk review"));
  const entry: CatalogEntry = {
    id: "native-review",
    kind: "skill",
    name: "review",
    description: "Harness review",
    source: { provider: "codex", scope: "global" },
    invocation: { type: "skill", name: "review", path: file },
  };
  await f.library.updateRuntime("thread", { group: "skills", catalog: [entry] });
  await f.library.updateRuntime("other", { group: "skills", catalog: [entry] });
  f.library.clearRuntime("thread");
  expect(
    (await f.library.listCatalog("other", "review", 100)).entries.find((e) => e.kind === "skill"),
  ).toMatchObject({ description: "Harness review" });
  await f.library.updateRuntime("other", {
    group: "skills",
    catalog: [{ ...entry, invocation: { type: "unavailable", reason: "Disabled" } }],
  });
  expect(
    (await f.library.listCatalog("other", "review", 100)).entries.find((e) => e.kind === "skill"),
  ).toMatchObject({ invocation: { type: "unavailable", reason: "Disabled" } });
});

test("loaded Claude plugins contribute namespaced definitions and command changes retain plugin and MCP entries", async () => {
  const f = await fixture("claude");
  const plugin = join(f.root, "plugin");
  const skill = join(plugin, "skills/fix/SKILL.md");
  await f.put(
    skill,
    "---\nname: fix\ndescription: Fix project issues\n---\nSynthetic plugin instructions",
  );
  await f.library.updateRuntime("thread", {
    type: "system",
    subtype: "init",
    slash_commands: ["quality:fix"],
    skills: ["quality:fix"],
    plugins: [{ name: "quality", path: plugin }],
    tools: ["mcp__docs__search"],
  });
  const first = await waitFor(f.library, (entries) =>
    entries.some((e) => e.name === "quality:fix" && e.description === "Fix project issues"),
  );
  expect(first.find((e) => e.name === "quality:fix")).toMatchObject({
    kind: "skill",
    source: { scope: "plugin", plugin: "quality", path: skill },
  });
  await f.library.updateRuntime("thread", {
    type: "system",
    subtype: "init",
    slash_commands: [{ name: "quality:fix", description: "Native description" }],
  });
  const changed = await f.library.listCatalog("thread", "", 512);
  expect(changed.entries.find((e) => e.kind === "plugin")).toMatchObject({ name: "quality" });
  expect(changed.entries.find((e) => e.kind === "mcp-tool")).toMatchObject({
    invocation: { type: "tool", name: "mcp__docs__search", server: "docs" },
  });
  expect(changed.entries.find((e) => e.name === "quality:fix")).toMatchObject({
    kind: "skill",
    description: "Native description",
  });
});
test("deleting a definition removes its chip target and active native lists disable unadvertised file entries", async () => {
  const f = await fixture("claude");
  const file = join(f.project, ".claude/skills/local/SKILL.md");
  await f.put(file, "---\nname: local\ndescription: Local skill\n---\nInstructions");
  const first = await waitFor(f.library, (entries) => entries.some((e) => e.name === "local"));
  const skill = first.find((e) => e.name === "local");
  if (!skill) throw new Error("Missing skill");
  await f.library.updateRuntime("thread", { type: "system", subtype: "init", slash_commands: [] });
  expect(
    (await f.library.listCatalog("thread", "local", 100)).entries.find((e) => e.kind === "skill"),
  ).toMatchObject({ invocation: { type: "unavailable" } });
  const removed = waitFor(f.library, (entries) => !entries.some((e) => e.name === "local"));
  await rm(file);
  await removed;
  await expect(
    f.library.prepareMentions("thread", [
      { type: "mention", entryId: skill.id, name: "local", kind: "skill", arguments: "" },
    ]),
  ).rejects.toThrow("catalog_mention_unavailable");
});

test("metadata file changes invalidate cached harness extras and retain account scoping", async () => {
  let description = "First plugin metadata";
  const f = await fixture("claude", async () => [
    {
      id: "plugin",
      name: "quality",
      kind: "plugin",
      description,
      source: { provider: "claude", scope: "global" },
      invocation: { type: "plugin", name: "quality" },
    },
  ]);
  await f.put(join(f.home, "settings.json"), "not parsed by the metadata watcher");
  await waitFor(f.library, (entries) =>
    entries.some((e) => e.description === "First plugin metadata"),
  );
  description = "Changed plugin metadata";
  const changed = waitFor(f.library, (entries) =>
    entries.some((e) => e.description === "Changed plugin metadata"),
  );
  await writeFile(join(f.home, "settings.json"), "still not parsed");
  expect((await changed).find((e) => e.id === "plugin")?.description).toBe(
    "Changed plugin metadata",
  );
});
test("Cursor command chips expand the real local definition in the middle of the native prompt", async () => {
  const f = await fixture("cursor");
  await f.put(
    join(f.project, ".cursor/commands/explain.md"),
    "---\ndescription: Explain code\n---\nExplain $ARGUMENTS using project conventions.",
  );
  const entries = await waitFor(f.library, (items) => items.some((e) => e.name === "explain"));
  const command = entries.find((e) => e.name === "explain");
  if (!command) throw new Error("Missing Cursor command");
  expect(
    await f.library.prepareMentions("thread", [
      { type: "text", text: "Please " },
      {
        type: "mention",
        entryId: command.id,
        name: "explain",
        kind: "command",
        arguments: "the parser",
      },
    ]),
  ).toEqual([{ type: "text", text: "Please Explain the parser using project conventions." }]);
});

test("a skill selected before session startup stays linked when the harness advertises its native identity", async () => {
  const f = await fixture("codex");
  const path = join(f.project, ".agents/skills/review/SKILL.md");
  await f.put(path, "---\nname: review\ndescription: Review project changes\n---\nBody");
  const first = await waitFor(f.library, (entries) =>
    entries.some((e) => e.name === "review" && e.kind === "skill"),
  );
  const selected = first.find((e) => e.name === "review" && e.kind === "skill");
  if (!selected) throw new Error("Missing skill");
  await f.library.updateRuntime("thread", {
    group: "skills-list",
    catalog: [
      {
        id: "codex:skill:native-review",
        kind: "skill",
        name: "Review changes",
        description: "Native review",
        source: { provider: "codex", scope: "project", path },
        invocation: { type: "skill", name: "review", path },
      },
    ],
  });
  expect(
    await f.library.prepareMentions("thread", [
      { type: "text", text: "Please " },
      { type: "mention", entryId: selected.id, name: selected.name, kind: "skill", arguments: "" },
    ]),
  ).toMatchObject([
    { text: "Please " },
    {
      type: "mention",
      name: "Review changes",
      invocation: { type: "skill", name: "review", path },
    },
  ]);
});

test("ace project skills expose their declared arguments and expand structured values without losing chip identity", async () => {
  const f = await fixture("claude");
  await f.put(
    join(f.project, ".ace/skills/explain/SKILL.md"),
    "---\nname: explain\ndescription: Explain a topic\narguments:\n  topic: { type: string, required: true }\n---\nExplain {{topic}}.",
  );
  const entries = await waitFor(f.library, (items) =>
    items.some((e) => e.source.provider === "ace" && e.kind === "skill"),
  );
  const skill = entries.find((e) => e.source.provider === "ace" && e.kind === "skill");
  if (!skill) throw new Error("Missing ace skill");
  expect(skill).toMatchObject({
    source: { scope: "project" },
    invocation: { type: "prompt", parameters: { topic: { type: "string", required: true } } },
  });
  expect(
    await f.library.prepareMentions("thread", [
      {
        type: "mention",
        entryId: skill.id,
        name: skill.name,
        kind: "skill",
        arguments: "",
        values: { topic: "the queue" },
      },
    ]),
  ).toEqual([{ type: "text", text: "Explain the queue." }]);
});

test("Claude registry plugins expose namespaced components before startup and retain unavailable components under isolation", async () => {
  let entries: CatalogEntry[] = [];
  const f = await fixture("claude", async () => entries);
  const pluginPath = join(f.root, "installed-plugin");
  await f.put(
    join(pluginPath, "skills/review/SKILL.md"),
    "---\nname: review\ndescription: Installed review\n---\nReview instructions",
  );
  entries = [
    {
      id: "installed",
      kind: "plugin",
      name: "quality",
      description: "Installed plugin",
      source: { provider: "claude", scope: "global", path: pluginPath },
      invocation: {
        type: "unavailable",
        reason: "Not yet advertised as loaded by the provider session",
      },
    },
  ];
  const catalog = await waitFor(f.library, (items) =>
    items.some((e) => e.description === "Installed review"),
  );
  expect(catalog.find((e) => e.description === "Installed review")).toMatchObject({
    name: "quality:review",
    source: { scope: "plugin", plugin: "quality" },
  });
  await f.library.updateRuntime("thread", {
    type: "system",
    subtype: "init",
    slash_commands: [],
    plugins: [],
  });
  expect((await f.library.listCatalog("thread", "quality:review")).entries).toMatchObject([
    {
      invocation: { type: "unavailable", reason: "Not advertised by the active provider session" },
    },
  ]);
});

test.each(["claude", "pi"] as const)(
  "%s publishes skills from one folder link inside the user's home on cold start",
  async (provider) => {
    const f = await fixture(provider);
    const shared = join(f.root, ".agents/skills/clerk");
    await f.put(
      join(shared, "SKILL.md"),
      "---\nname: clerk\ndescription: Set up authentication\n---\nUse the installed skill.",
    );
    await mkdir(join(f.home, "skills"), { recursive: true });
    await symlink(relative(join(f.home, "skills"), shared), join(f.home, "skills/clerk"));
    await symlink(join(f.home, "skills/clerk"), join(f.home, "skills/chained"));
    const outside = await realpath(await mkdtemp(join(tmpdir(), "ace-outside-skills-")));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await f.put(
      join(outside, "SKILL.md"),
      "---\nname: outside\ndescription: Outside home\n---\nBody",
    );
    await symlink(outside, join(f.home, "skills/outside"));
    await f.put(
      join(f.root, ".agents/skills/nested/SKILL.md"),
      "---\nname: nested\ndescription: Nested link\n---\nBody",
    );
    await mkdir(join(f.home, "skills/real"));
    await symlink(join(f.root, ".agents/skills/nested"), join(f.home, "skills/real/nested"));
    const discovered = await waitFor(f.library, (entries) =>
      entries.some((entry) => entry.name === "clerk"),
    );
    expect(discovered.filter((entry) => entry.kind === "skill").map((entry) => entry.name)).toEqual(
      ["clerk"],
    );
    const skill = discovered.find((entry) => entry.name === "clerk");
    if (!skill) throw new Error("Skill missing");
    const prepared = await f.library.prepareMentions("thread", [
      { type: "mention", entryId: skill.id, name: "clerk", kind: "skill", arguments: "" },
    ]);
    if (provider === "claude")
      expect(prepared).toMatchObject([{ type: "text", text: expect.stringContaining("clerk") }]);
    else
      expect(prepared).toMatchObject([
        { type: "mention", invocation: { type: "slash", name: "skill:clerk" } },
      ]);
  },
);
