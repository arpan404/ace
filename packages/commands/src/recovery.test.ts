import { mkdtemp, realpath, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, it, expect } from "vitest";
import { CommandCatalog, CommandFiles } from "./index.ts";
const controlled = { watch: () => () => {}, schedule: () => () => {} };
const target = { provider: "claude", instance: "personal", session: "test" } as const;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-command-recovery-")));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const root = join(home, "prompts");
  await mkdir(root);
  const catalog = new CommandCatalog(() => 0);
  const files = new CommandFiles(
    catalog,
    [{ path: root, format: "library", scope: "user" }],
    controlled,
  );
  cleanups.push(() => files.close());
  return { root, catalog, files };
}
it("repairs missed body edits in bounded batches without scanning all sources", async () => {
  const f = await fixture();
  for (let i = 0; i < 64; i++) await writeFile(join(f.root, `value-${i}.md`), "Original");
  await f.files.start();
  const commands = f.catalog.list(target, "value", 100).commands;
  expect(commands).toHaveLength(64);
  for (let i = 0; i < 64; i++) await writeFile(join(f.root, `value-${i}.md`), "Changed");
  await f.files.reconcile();
  const changed = () =>
    commands.filter((command) => {
      const result = f.catalog.resolve(target, command.id);
      return result.ok && result.plan.kind === "prompt" && result.plan.text === "Changed";
    }).length;
  expect(changed()).toBeGreaterThan(0);
  expect(changed()).toBeLessThanOrEqual(32);
  for (let i = 0; i < 4; i++) await f.files.reconcile();
  expect(changed()).toBe(64);
});
it("repairs a missed deletion across overlapping roots", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "shared.md"), "Shared");
  const files = new CommandFiles(
    f.catalog,
    [
      { path: f.root, format: "library", scope: "user" },
      { path: f.root, format: "library", scope: "workspace" },
    ],
    controlled,
  );
  cleanups.push(() => files.close());
  await files.start();
  expect(f.catalog.list(target, "shared").commands[0]?.scope).toBe("workspace");
  await rm(join(f.root, "shared.md"));
  await files.reconcile();
  expect(f.catalog.list(target, "shared").commands).toEqual([]);
});
it("recovers creation of a missing root without native notifications", async () => {
  const f = await fixture();
  await rm(f.root, { recursive: true });
  await f.files.start();
  await mkdir(f.root);
  await writeFile(join(f.root, "new.md"), "New");
  await f.files.reconcile();
  const command = f.catalog.list(target, "new").commands[0];
  if (!command) throw new Error("Missing command");
  expect(f.catalog.resolve(target, command.id)).toEqual({
    ok: true,
    plan: { kind: "prompt", provider: "claude", text: "New" },
  });
});

it("removes a cached snippet when its file becomes a nonregular filesystem entry", async () => {
  const f = await fixture(),
    path = join(f.root, "item.md");
  await writeFile(path, "Original");
  await f.files.start();
  const command = f.catalog.list(target, "item").commands[0];
  if (!command) throw new Error("Missing snippet");
  expect(f.catalog.resolve(target, command.id)).toMatchObject({
    ok: true,
    plan: { text: "Original" },
  });
  await rm(path);
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  f.files.invalidate(path);
  await f.files.flush();
  expect(f.catalog.resolve(target, command.id)).toEqual({ ok: false, error: "not_found" });
});

it("removes cached OpenCode commands when their config file becomes a directory", async () => {
  const f = await fixture(),
    path = join(f.root, "opencode.json");
  await writeFile(path, JSON.stringify({ command: { review: { template: "Review" } } }));
  const files = new CommandFiles(
    f.catalog,
    [{ path, format: "opencode-config", scope: "user", instance: "personal" }],
    controlled,
  );
  cleanups.push(() => files.close());
  await files.start();
  const opencode = { ...target, provider: "opencode" } as const;
  const command = f.catalog
    .list(opencode, "review")
    .commands.find((c) => c.namespace === "provider");
  if (!command) throw new Error("Missing OpenCode command");
  expect(f.catalog.resolve(opencode, command.id)).toMatchObject({
    ok: true,
    plan: { kind: "native", text: "/review" },
  });
  await rm(path);
  await mkdir(path);
  await files.reconcile();
  expect(f.catalog.resolve(opencode, command.id)).toEqual({ ok: false, error: "not_found" });
});

it("drains invalidations queued during a flush before the batch completes", async () => {
  const f = await fixture();
  for (const name of ["one", "two"]) await writeFile(join(f.root, `${name}.md`), "Original");
  await f.files.start();
  const two = f.catalog.list(target, "two").commands.find((c) => c.name === "two");
  if (!two) throw new Error("Missing second snippet");
  for (const name of ["one", "two"]) await writeFile(join(f.root, `${name}.md`), "Changed");
  let queued = false;
  f.files.subscribe(() => {
    if (queued) return;
    queued = true;
    f.files.invalidate(join(f.root, "two.md"));
    void f.files.flush();
  });
  f.files.invalidate(join(f.root, "one.md"));
  await f.files.flush();
  expect(f.catalog.resolve(target, two.id)).toEqual({
    ok: true,
    plan: { kind: "prompt", provider: "claude", text: "Changed" },
  });
});
