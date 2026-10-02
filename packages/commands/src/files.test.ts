import { mkdtemp, mkdir, writeFile, rm, rename, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it, expect } from "vitest";
import {
  CommandCatalog,
  CommandFiles,
  CommandLibrary,
  discoveryRoots,
  type Target,
} from "./index.ts";
const target: Target = { provider: "claude", instance: "personal", session: "t" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "commands");
  await mkdir(root);
  const catalog = new CommandCatalog(() => 0);
  const files = new CommandFiles(catalog, [
    { path: root, format: "claude", scope: "user", instance: "personal" },
  ]);
  cleanups.push(() => files.close());
  return { home, root, catalog, files };
}
function changed(files: CommandFiles, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = files.subscribe(() => {
      if (predicate()) {
        stop();
        resolve();
      }
    });
  });
}
it("watches edits, malformed replacements, renames and deletions while retaining untouched commands", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "one.md"), "First");
  await writeFile(join(f.root, "two.md"), "Second");
  await f.files.start();
  const find = (name: string) =>
    f.catalog
      .list(target, name)
      .commands.find((d) => d.namespace === "provider" && d.name === name);
  const second = find("two");
  if (!second) throw new Error("Missing second");
  const initial = find("one");
  if (!initial) throw new Error("Missing first");
  let event = changed(f.files, () => find("one")?.description === "Edited");
  await writeFile(join(f.root, "one.md"), "---\ndescription: Edited\n---\nEdited");
  await event;
  expect(f.catalog.resolve(target, second.id)).toMatchObject({ ok: true, plan: { metadata: {} } });
  event = changed(f.files, () => f.catalog.list(target).diagnostics.length > 0);
  await writeFile(join(f.root, "one.md"), "---\ndescription: [broken\n---\nOops");
  await event;
  expect(find("one")).toBeUndefined();
  expect(find("two")?.id).toBe(second.id);
  event = changed(f.files, () => find("renamed") !== undefined && find("two") === undefined);
  await rename(join(f.root, "two.md"), join(f.root, "renamed.md"));
  await event;
  event = changed(f.files, () => find("renamed") === undefined);
  await rm(join(f.root, "renamed.md"));
  await event;
});
it("reads only invalidated paths and preserves cached results for all other files", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "one.md"), "One");
  await writeFile(join(f.root, "two.md"), "Two");
  await f.files.start();
  await f.files.close();
  // A second shell owns explicit invalidation without starting watchers.
  const files = new CommandFiles(f.catalog, [
    { path: f.root, format: "claude", scope: "user", instance: "personal" },
  ]);
  cleanups.push(() => files.close());
  const id = (name: string) => {
    const selected = f.catalog
      .list(target, name)
      .commands.find((d) => d.namespace === "provider" && d.name === name);
    if (!selected) throw new Error("Missing command");
    return selected.id;
  };
  const one = id("one"),
    two = id("two");
  await writeFile(join(f.root, "one.md"), "---\ndescription: Updated one\n---\nOne");
  await writeFile(join(f.root, "two.md"), "---\ndescription: Updated two\n---\nTwo");
  files.invalidate(join(f.root, "one.md"));
  await files.flush();
  expect(f.catalog.list(target, "one").commands.find((d) => d.id === one)?.description).toBe(
    "Updated one",
  );
  expect(f.catalog.list(target, "two").commands.find((d) => d.id === two)?.description).toBe("");
  files.invalidate(join(f.root, "two.md"));
  await files.flush();
  expect(f.catalog.list(target, "two").commands.find((d) => d.id === two)?.description).toBe(
    "Updated two",
  );
});
it("discovers missing roots on creation and removes all commands after a directory rename", async () => {
  const f = await fixture();
  await rm(f.root, { recursive: true });
  await f.files.start();
  let event = changed(f.files, () =>
    f.catalog.list(target, "new").commands.some((d) => d.name === "new"),
  );
  await mkdir(join(f.root, "nested"), { recursive: true });
  await writeFile(join(f.root, "new.md"), "New");
  await event;
  event = changed(f.files, () =>
    f.catalog.list(target, "nested:extra").commands.some((d) => d.name === "nested:extra"),
  );
  await writeFile(join(f.root, "nested/extra.md"), "Extra");
  await event;
  event = changed(f.files, () =>
    f.catalog.list(target).commands.every((d) => d.namespace !== "provider"),
  );
  await rename(f.root, join(f.home, "removed"));
  await event;
});
it("rejects symlink files, oversized bodies and ignores nested Codex prompts", async () => {
  const f = await fixture();
  await writeFile(join(f.home, "outside.md"), "Secret");
  await symlink(join(f.home, "outside.md"), join(f.root, "link.md"));
  await writeFile(join(f.root, "huge.md"), "x".repeat(65537));
  await f.files.start();
  expect(f.catalog.list(target).commands.every((d) => d.namespace !== "provider")).toBe(true);
  expect(f.catalog.list(target).diagnostics).toHaveLength(1);
  const codex = join(f.home, "codex/prompts");
  await mkdir(join(codex, "nested"), { recursive: true });
  await writeFile(join(codex, "top.md"), "Hi $1");
  await writeFile(join(codex, "nested/hidden.md"), "Hidden");
  const files = new CommandFiles(f.catalog, [
    { path: codex, format: "codex", scope: "user", instance: "codex" },
  ]);
  cleanups.push(() => files.close());
  await files.start();
  const ctx = { ...target, provider: "codex" as const, instance: "codex" };
  expect(
    f.catalog
      .list(ctx)
      .commands.filter((d) => d.namespace === "provider")
      .map((d) => d.name),
  ).toEqual(["top"]);
});
it("discovers multiple provider homes and library scopes through the service without client paths", async () => {
  const f = await fixture();
  const user = join(f.home, "user"),
    work = join(f.home, "work"),
    workspace = join(f.home, "project"),
    ace = join(f.home, "ace");
  for (const dir of [
    join(user, "commands"),
    join(work, "commands"),
    join(workspace, ".claude/commands"),
    join(workspace, ".ace/prompts"),
    join(ace, "prompts"),
  ])
    await mkdir(dir, { recursive: true });
  await writeFile(join(user, "commands/review.md"), "---\ndescription: User\n---\nUser");
  await writeFile(join(work, "commands/work.md"), "Work");
  await writeFile(
    join(workspace, ".claude/commands/review.md"),
    "---\ndescription: Project\n---\nProject",
  );
  await writeFile(join(ace, "prompts/explain.md"), "User prompt");
  await writeFile(join(workspace, ".ace/prompts/explain.md"), "Workspace prompt");
  const service = new CommandLibrary({
    aceHome: ace,
    instances: [
      { id: "personal", provider: "claude", home: user },
      { id: "work", provider: "claude", home: work },
    ],
    now: () => 0,
    context(thread) {
      return { workspace, provider: "claude", instance: thread };
    },
  });
  cleanups.push(() => service.close());
  const personal = await service.list("personal", "", 100);
  expect(
    personal.commands.find((d) => d.namespace === "provider" && d.name === "review")?.description,
  ).toBe("Project");
  expect(personal.commands.map((d) => d.name)).not.toContain("work");
  const prompt = personal.commands.find((d) => d.namespace === "prompt");
  if (!prompt) throw new Error("Missing prompt");
  expect(await service.resolve("personal", prompt.id, {}, [])).toEqual({
    ok: true,
    plan: { kind: "prompt", provider: "claude", text: "Workspace prompt" },
  });
  expect((await service.list("work", "work", 100)).commands.map((d) => d.name)).toContain("work");
  await service.updateRuntime("personal", {
    type: "system",
    subtype: "init",
    slash_commands: ["native"],
  });
  expect((await service.list("personal", "native", 100)).commands.map((d) => d.name)).toContain(
    "native",
  );
  service.clearRuntime("personal");
  expect((await service.list("personal", "native", 100)).commands).toEqual([]);
});
it("loads OpenCode config and skill definitions from registered discovery roots", async () => {
  const f = await fixture(),
    workspace = join(f.home, "project"),
    oc = join(f.home, "oc"),
    claude = join(f.home, "claude");
  await mkdir(workspace);
  await mkdir(oc);
  await mkdir(join(claude, "skills/test"), { recursive: true });
  await writeFile(
    join(workspace, "opencode.jsonc"),
    '{"command":{"test":{"template":"Run tests","description":"Project tests"}}}',
  );
  await writeFile(join(claude, "skills/test/SKILL.md"), "---\nname: test\n---\nRun tests");
  const catalog = new CommandCatalog(() => 0),
    files = new CommandFiles(
      catalog,
      discoveryRoots(
        [
          { id: "oc", provider: "opencode", home: oc },
          { id: "personal", provider: "claude", home: claude },
        ],
        join(f.home, "ace"),
        workspace,
      ),
    );
  cleanups.push(() => files.close());
  await files.start();
  const tests = catalog.list({ ...target, provider: "opencode", instance: "oc" }, "test").commands;
  expect(tests[0]?.description).toBe("Project tests");
  const skill = catalog.list(target, "test").commands[0];
  if (!skill) throw new Error("Missing skill");
  expect(catalog.resolve(target, skill.id)).toMatchObject({
    ok: true,
    plan: { kind: "native", text: "/test" },
  });
});

it("does not discover project prompts through a symlinked configuration directory", async () => {
  const f = await fixture(),
    workspace = join(f.home, "project"),
    outside = join(f.home, "outside");
  await mkdir(workspace);
  await mkdir(join(outside, "prompts"), { recursive: true });
  await writeFile(join(outside, "prompts/secret.md"), "Secret");
  await symlink(outside, join(workspace, ".ace"));
  const files = new CommandFiles(f.catalog, discoveryRoots([], join(f.home, "ace"), workspace));
  cleanups.push(() => files.close());
  await files.start();
  expect(f.catalog.list(target, "secret").commands).toEqual([]);
});
