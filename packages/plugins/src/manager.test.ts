import { DatabaseSync } from "node:sqlite";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PluginManager, inspectPackage, limits } from "./index.ts";
import { fixture, git, sampleFiles, sampleManifest, writeFiles } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(files?: Record<string, string>) {
  const value = await fixture(files);
  cleanups.push(value.close);
  return value;
}

test("preparing reveals every executable and remote endpoint without installing or executing", async () => {
  const f = await setup();
  const marker = join(f.root, "executed");
  await writeFiles(join(f.repo, "plugins/sample"), {
    "ace-plugin.json": JSON.stringify({
      ...sampleManifest,
      hooks: [{ event: "Stop", command: `touch '${marker}'` }],
    }),
  });
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "command review"]);
  const review = await f.prepare();
  expect(review.executions).toContainEqual({
    kind: "hook",
    event: "Stop",
    command: `touch '${marker}'`,
  });
  expect(review.executions).toContainEqual({
    kind: "stdio",
    name: "tools",
    command: "node",
    args: ["${PLUGIN_ROOT}/scripts/server.js", 'a quote: "'],
    env: { MODE: "local" },
  });
  expect(review.executions).toContainEqual({
    kind: "remote",
    name: "docs",
    type: "http",
    url: "https://example.com/mcp",
    headers: { "X-Mode": "test" },
  });
  expect(f.manager.list()).toEqual([]);
  await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  const accepted = await f.manager.accept(review);
  expect(accepted.acceptedAt).toBe(123);
  await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
test("consent pins the prepared commit even after the marketplace branch changes", async () => {
  const f = await setup();
  const review = await f.prepare();
  const commit = await git(f.repo, ["rev-parse", "HEAD"]);
  await writeFile(join(f.repo, "plugins/sample/rules/style.md"), "Changed after review");
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "move branch"]);
  await expect(f.manager.accept({ ...review, hash: "0".repeat(64) })).rejects.toThrow("Consent");
  await expect(f.manager.accept({ ...review, commit: "0".repeat(40) })).rejects.toThrow("Consent");
  const accepted = await f.manager.accept(review);
  expect(accepted.commit).toBe(commit);
  expect((await f.manager.installed())[0]?.text["rules/style.md"]).toBe("Use TypeScript.");
  await expect(f.manager.accept(review)).rejects.toThrow("Review not found");
});
test("update requires new consent for changed scripts even when version and command stay the same", async () => {
  const f = await setup();
  const first = await f.prepare();
  await f.manager.accept(first);
  await writeFile(join(f.repo, "plugins/sample/scripts/start.js"), "console.log('updated');");
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "script change"]);
  const update = await f.manager.update("sample");
  expect(update.hash).not.toBe(first.hash);
  expect(update.version).toBe(first.version);
  expect(f.manager.list()[0]?.hash).toBe(first.hash);
  await expect(f.manager.accept({ ...update, hash: first.hash })).rejects.toThrow("Consent");
  await f.manager.accept(update);
  expect(
    await readFile(join(f.managerRoot, "versions", update.hash, "scripts/start.js"), "utf8"),
  ).toBe("console.log('updated');");
  expect(await readdir(join(f.managerRoot, "versions"))).toEqual([update.hash]);
  expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
  await f.manager.remove("sample");
  expect(f.manager.list()).toEqual([]);
  expect(await readdir(join(f.managerRoot, "versions"))).toEqual([]);
  expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
  expect(await readdir(join(f.managerRoot, "fetch"))).toEqual([]);
});
test("reviews and accepted trust survive reopening and executable bits survive Git extraction", async () => {
  const f = await setup();
  const review = await f.prepare();
  await f.reopen();
  await f.manager.accept(review);
  await f.reopen();
  expect(f.manager.list()).toEqual([
    { name: "sample", version: "1.0", commit: review.commit, hash: review.hash, acceptedAt: 123 },
  ]);
  const snapshot = (await f.manager.installed())[0];
  expect(snapshot?.manifest.commands[0]?.name).toBe("check");
  expect(
    (await lstat(join(f.managerRoot, "versions", review.hash, "scripts/start.js"))).mode & 0o111,
  ).not.toBe(0);
});
test("staged tampering and accepted content or mode tampering cannot acquire or retain trust", async () => {
  const f = await setup();
  const review = await f.prepare();
  await writeFile(join(f.managerRoot, "staging", review.id, "rules/style.md"), "Tampered");
  await expect(f.manager.accept(review)).rejects.toThrow("Integrity mismatch");
  expect(f.manager.list()).toEqual([]);
  await f.manager.cancel(review.id);
  const next = await f.prepare();
  await f.manager.accept(next);
  const script = join(f.managerRoot, "versions", next.hash, "scripts/start.js");
  await chmod(script, 0o600);
  await expect(f.manager.installed()).rejects.toThrow("Integrity mismatch");
  await chmod(script, 0o700);
  await writeFile(script, "tampered");
  await expect(f.manager.installed()).rejects.toThrow("Integrity mismatch");
});
test("catalog integrity mismatch rejects the package and cleans temporary files", async () => {
  const f = await setup();
  await writeFile(
    join(f.repo, "marketplace.json"),
    JSON.stringify({
      name: "market",
      plugins: [{ name: "sample", source: "./plugins/sample", hash: "0".repeat(64) }],
    }),
  );
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "bad integrity"]);
  await expect(f.prepare()).rejects.toThrow("Integrity mismatch");
  expect(f.manager.list()).toEqual([]);
  expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
  expect(await readdir(join(f.managerRoot, "fetch"))).toEqual([]);
});
test("Git symlinks and oversized blobs are rejected before materialization", async () => {
  const f = await setup();
  await symlink("/etc/passwd", join(f.repo, "plugins/sample/escape"));
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "symlink"]);
  await expect(f.prepare()).rejects.toThrow();
  expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
  const huge = await setup({ ...sampleFiles, "huge.bin": "x".repeat(limits.file + 1) });
  await expect(huge.prepare()).rejects.toThrow();
  expect(await readdir(join(huge.managerRoot, "staging"))).toEqual([]);
});
test("traversal catalogs, missing components and mismatched identities cannot install", async () => {
  const f = await setup();
  await writeFile(
    join(f.repo, "marketplace.json"),
    JSON.stringify({ name: "market", plugins: [{ name: "sample", source: "../outside" }] }),
  );
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "traversal"]);
  await expect(f.prepare()).rejects.toThrow();
  const missing = await setup({ "ace-plugin.json": JSON.stringify(sampleManifest) });
  await expect(missing.prepare()).rejects.toThrow("Skill missing");
  const identity = await setup({
    ...sampleFiles,
    "ace-plugin.json": JSON.stringify({ ...sampleManifest, name: "different" }),
  });
  await expect(identity.prepare()).rejects.toThrow("name mismatch");
});
test("startup and removal collect abandoned versions, fetches and pending stages", async () => {
  const f = await setup();
  const review = await f.prepare();
  await f.manager.accept(review);
  await mkdir(join(f.managerRoot, "versions", "abandoned"));
  await mkdir(join(f.managerRoot, "fetch", "abandoned"));
  await mkdir(join(f.managerRoot, "staging", "abandoned"));
  await f.reopen();
  expect(await readdir(join(f.managerRoot, "versions"))).toEqual([review.hash]);
  expect(await readdir(join(f.managerRoot, "fetch"))).toEqual([]);
  expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
  await f.prepare();
  await f.manager.remove("sample");
  expect(await readdir(join(f.managerRoot, "staging"))).toEqual([]);
});
test("a competing manager cannot mutate while the directory transaction is held", async () => {
  const f = await setup();
  const lock = new DatabaseSync(join(f.managerRoot, "operation.sqlite"));
  lock.exec("BEGIN IMMEDIATE");
  try {
    await expect(f.manager.remove("sample")).rejects.toThrow("busy");
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  const review = await f.prepare();
  await f.manager.accept(review);
  expect(f.manager.list()).toHaveLength(1);
});
test("package hash includes paths and executable permissions", async () => {
  const f = await setup();
  const path = join(f.repo, "plugins/sample");
  const first = await inspectPackage(path);
  await chmod(join(path, "scripts/start.js"), 0o600);
  expect((await inspectPackage(path)).hash).not.toBe(first.hash);
  await rename(join(path, "rules/style.md"), join(path, "rules/renamed.md"));
  expect((await inspectPackage(path)).hash).not.toBe(first.hash);
});
test("existing user directories are refused", async () => {
  const f = await setup();
  const user = join(f.root, "user");
  await writeFiles(user, { "config.json": "unchanged" });
  await expect(PluginManager.open({ root: user, now: () => 0, id: () => "test" })).rejects.toThrow(
    "nonempty",
  );
  expect(await readFile(join(user, "config.json"), "utf8")).toBe("unchanged");
});

test("Claude marketplaces and repository-root plugins import without a checkout or filters", async () => {
  const f = await setup();
  const marker = join(f.root, "smudged");
  await writeFiles(f.repo, {
    ".claude-plugin/marketplace.json": JSON.stringify({
      name: "market",
      plugins: [{ name: "sample", source: "./" }],
    }),
    ...sampleFiles,
    ".gitattributes": "*.md filter=evil",
  });
  await git(f.repo, ["rm", "marketplace.json"]);
  await git(f.repo, ["config", "filter.evil.smudge", `touch '${marker}'`]);
  await git(f.repo, ["config", "filter.evil.required", "true"]);
  await git(f.repo, ["config", "filter.evil.clean", "cat"]);
  await git(f.repo, ["add", "."]);
  await git(f.repo, ["commit", "-m", "root plugin"]);
  const review = await f.prepare();
  await f.manager.accept(review);
  expect((await f.manager.installed())[0]?.manifest.skills[0]?.name).toBe("review");
  await expect(lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
});
test("symlinked database and ownership marker paths cannot modify a user file", async () => {
  const f = await setup();
  const userFile = join(f.root, "user-config");
  await writeFile(userFile, "unchanged");
  const owned = join(f.root, "owned");
  const manager = await PluginManager.open({ root: owned, now: () => 0, id: () => "id" });
  manager.close();
  await rename(join(owned, "registry.sqlite"), join(owned, "registry.backup"));
  await symlink(userFile, join(owned, "registry.sqlite"));
  await expect(PluginManager.open({ root: owned, now: () => 0, id: () => "id" })).rejects.toThrow(
    "Symlink",
  );
  const badMarker = join(f.root, "bad-marker");
  await mkdir(badMarker);
  await symlink(userFile, join(badMarker, ".ace-plugins-owned"));
  await expect(
    PluginManager.open({ root: badMarker, now: () => 0, id: () => "id" }),
  ).rejects.toThrow("Symlink");
  expect(await readFile(userFile, "utf8")).toBe("unchanged");
});
