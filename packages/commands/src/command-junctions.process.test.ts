import { afterEach, expect, test, vi } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceId } from "@ace/protocol";
import { CommandCatalog, CommandFiles, PromptFiles, type Target } from "./index.ts";

// Command discovery and prompt files over Windows handles; every case runs only on Windows.
const windows = test.runIf(process.platform === "win32");
const target: Target = { provider: "claude", instance: "personal", session: "t" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-junction-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "commands");
  const outside = join(home, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "---\ndescription: Private\n---\nSecret");
  const catalog = new CommandCatalog(() => 0);
  const files = new CommandFiles(catalog, [
    { path: root, format: "claude", scope: "user", instance: "personal" },
  ]);
  cleanups.push(() => files.close());
  const names = () => catalog.list(target).commands.map((command) => command.name);
  const description = (name: string) =>
    catalog
      .list(target, name)
      .commands.find((command) => command.namespace === "provider" && command.name === name)
      ?.description;
  return { home, root, outside, catalog, files, names, description };
}

windows("Windows command discovery reads a drive-absolute root and picks up edits", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "one.md"), "---\ndescription: First\n---\nOne");
  await mkdir(join(f.root, "nested"));
  await writeFile(join(f.root, "nested", "two.md"), "---\ndescription: Second\n---\nTwo");
  await f.files.start();
  expect(f.description("one")).toBe("First");
  expect(f.names().some((name) => name.includes("two"))).toBe(true);
  await writeFile(join(f.root, "one.md"), "---\ndescription: Edited\n---\nOne");
  f.files.invalidate(join(f.root, "one.md"));
  await f.files.flush();
  expect(f.description("one")).toBe("Edited");
});

windows("Windows command discovery refuses a junction swapped into a command root", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "real.md"), "---\ndescription: Real\n---\nReal");
  await symlink(f.outside, join(f.root, "linked"), "junction");
  await f.files.start();
  expect(f.description("real")).toBe("Real");
  expect(f.names().some((name) => name.includes("secret"))).toBe(false);
  // The root itself becomes a junction to the outside folder.
  await rename(f.root, join(f.home, "moved"));
  await symlink(f.outside, f.root, "junction");
  f.files.invalidate(f.root);
  await f.files.flush();
  expect(f.names().some((name) => name.includes("secret"))).toBe(false);
  expect(f.description("real")).toBeUndefined();
});

windows("Windows prompt files save, reopen and refuse a junctioned prompt folder", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-prompt-junction-")));
  const home = join(root, "home");
  const project = join(root, "project");
  const outside = join(root, "outside");
  await mkdir(home);
  await mkdir(join(project, ".ace"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.md"), "Private fixture");
  await symlink(outside, join(project, ".ace", "prompts"), "junction");
  let id = 0;
  const files = new PromptFiles({
    globalRoot: home,
    projectRoot: (key) => (key === "project" ? project : undefined),
    id: () => String(++id),
  });
  cleanups.push(async () => {
    files.close();
    await rm(root, { recursive: true, force: true });
  });
  const global = { kind: "global" as const };
  const created = await files.request({
    op: "write",
    scope: global,
    name: "review.md",
    text: "Original",
    expectedRevision: null,
  });
  expect(created.kind).toBe("file");
  const opened = await files.request({ op: "read", scope: global, name: "review.md" });
  if (opened.kind !== "file") throw new Error("Prompt did not open");
  const saved = await files.request({
    op: "write",
    scope: global,
    name: "review.md",
    text: "Edited",
    expectedRevision: opened.revision,
  });
  expect(saved.kind).toBe("file");
  expect(await readFile(join(home, "prompts", "review.md"), "utf8")).toBe("Edited");
  expect(
    await files.request({
      op: "write",
      scope: global,
      name: "review.md",
      text: "Stale",
      expectedRevision: opened.revision,
    }),
  ).toMatchObject({ kind: "error", code: "conflict" });

  const scope = { kind: "project" as const, workspaceId: WorkspaceId.parse("project") };
  expect(await files.request({ op: "read", scope, name: "secret.md" })).toMatchObject({
    kind: "error",
  });
  expect(
    await files.request({
      op: "write",
      scope,
      name: "new.md",
      text: "Intrusion",
      expectedRevision: null,
    }),
  ).toMatchObject({ kind: "error" });
  expect(await readFile(join(outside, "secret.md"), "utf8")).toBe("Private fixture");
});

windows(
  "Windows command discovery lets the person rename and delete watched command folders",
  async () => {
    const f = await fixture();
    await mkdir(join(f.root, "nested", "deeper"), { recursive: true });
    await writeFile(join(f.root, "top.md"), "Top");
    await writeFile(join(f.root, "nested", "inner.md"), "Inner");
    await writeFile(join(f.root, "nested", "deeper", "low.md"), "Low");
    await f.files.start();
    const has = (part: string) => f.names().some((name) => name.includes(part));
    expect(has("inner") && has("low")).toBe(true);
    // While ace watches, the person renames a nested folder, then deletes it, then the whole root.
    await rename(join(f.root, "nested"), join(f.root, "renamed"));
    await vi.waitFor(
      () => expect(f.names().some((name) => name.startsWith("renamed"))).toBe(true),
      {
        timeout: 10_000,
      },
    );
    expect(f.names().some((name) => name.startsWith("nested"))).toBe(false);
    await rm(join(f.root, "renamed"), { recursive: true });
    await vi.waitFor(() => expect(has("inner") || has("low")).toBe(false), { timeout: 10_000 });
    await rename(f.root, join(f.home, "moved"));
    await vi.waitFor(() => expect(has("top")).toBe(false), { timeout: 10_000 });
    await rm(join(f.home, "moved"), { recursive: true });
  },
);

windows("Windows removes a cached command when its file becomes a junction", async () => {
  const f = await fixture();
  const path = join(f.root, "item.md");
  await writeFile(path, "Original");
  await f.files.start();
  const command = f.catalog.list(target, "item").commands[0];
  if (!command) throw new Error("Missing command");
  expect(f.catalog.resolve(target, command.id)).toMatchObject({ ok: true });
  // Windows has no sockets or FIFOs in folders; a junction is its nonregular entry.
  await rm(path);
  await symlink(f.outside, path, "junction");
  f.files.invalidate(path);
  await f.files.flush();
  expect(f.catalog.resolve(target, command.id)).toEqual({ ok: false, error: "not_found" });
  expect(f.catalog.list(target, "item").commands.some((c) => c.id === command.id)).toBe(false);
});

windows(
  "Windows command discovery finds folders added in the same clock tick as the last scan",
  async () => {
    const f = await fixture();
    await f.files.start();
    // Windows stamps folder times from a ~16 ms clock: each folder lands right after a scan, often
    // inside the same tick, so its parent's times can't show the change.
    for (let round = 0; round < 20; round++) {
      await mkdir(join(f.root, `set${round}`));
      await writeFile(join(f.root, `set${round}`, "item.md"), "Body");
      f.files.invalidate(f.root);
      await f.files.flush();
      expect(f.names()).toContain(`set${round}:item`);
    }
  },
);
