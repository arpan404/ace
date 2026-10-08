import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SettingsService } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}

test("a global alias cannot migrate or read workspace settings through a replaced directory", async () => {
  const f = await setup();
  const ace = join(f.workspace, ".ace");
  await mkdir(ace);
  const service = new SettingsService({
    dataDir: ace,
    io: f.edges.io,
    scheduler: f.edges.scheduler,
  });
  cleanups.push(() => service.close());
  await service.set("notifications.sound", true, { kind: "global" });
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const path = join(outside, "settings.json");
  const source = '{"version":1,"values":{"notifications.sound":false}}';
  await writeFile(path, source);
  await rename(ace, join(f.workspace, "old-ace"));
  await symlink(outside, ace, "dir");
  await service.refresh({ kind: "workspace", workspace: f.workspace });
  const result = await service.read({
    keys: ["notifications.sound"],
    scope: { workspace: f.workspace },
  });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "validation", layer: "workspace" }),
  );
  expect(result.entries[0]).toMatchObject({ value: true });
  expect(await readFile(path, "utf8")).toBe(source);
});

test.each([1, 2])(
  "reloading a protected workspace cannot read or migrate an outside v%i file",
  async (version) => {
    const f = await setup();
    await f.service.set("notifications.sound", true, { kind: "workspace", workspace: f.workspace });
    const ace = join(f.workspace, ".ace");
    const outside = join(f.root, "outside");
    await mkdir(outside);
    const path = join(outside, "settings.json");
    const source = JSON.stringify({
      version,
      [version === 1 ? "values" : "settings"]: { "notifications.sound": false },
    });
    await writeFile(path, source);
    await rename(ace, join(f.workspace, "old-ace"));
    await symlink(outside, ace, "dir");
    await f.service.refresh({ kind: "workspace", workspace: f.workspace });
    const result = await f.service.read({
      keys: ["notifications.sound"],
      scope: { workspace: f.workspace },
    });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validation" }));
    expect(result.entries[0]).toMatchObject({ value: true });
    expect(await readFile(path, "utf8")).toBe(source);
  },
);

test.each([0, 80])(
  "assignments cannot repin a moved workspace root after %i inactive scope reads",
  async (count) => {
    const f = await setup();
    const target = join(f.root, "target");
    const dataDir = join(target, ".ace");
    await mkdir(dataDir, { recursive: true });
    const service = new SettingsService({ dataDir, io: f.edges.io, scheduler: f.edges.scheduler });
    cleanups.push(() => service.close());
    await service.set("notifications.sound", true, { kind: "global" });
    await service.get("notifications.sound", { workspace: f.workspace });
    for (let index = 0; index < count; index++)
      await service.get("notifications.sound", { thread: `inactive-${index}` });
    const source = await readFile(join(dataDir, "settings.json"), "utf8");
    await rename(f.workspace, join(f.root, "old-repo"));
    await symlink(target, f.workspace, "dir");
    // Refresh must retain the original identity even when the physical cache was reclaimed.
    await service.refresh({ kind: "workspace", workspace: f.workspace });
    expect(
      (await service.read({ keys: ["notifications.sound"], scope: { workspace: f.workspace } }))
        .diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "validation" }));
    await expect(
      service.set("notifications.sound", false, { kind: "workspace", workspace: f.workspace }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(await readFile(join(dataDir, "settings.json"), "utf8")).toBe(source);
    await service.refresh({ kind: "global" });
    expect(await service.get("notifications.sound")).toMatchObject({
      value: true,
      provenance: "global",
    });
  },
);

test("workspace identity capacity applies backpressure while pinned identities remain effective", async () => {
  const f = await setup();
  const first = join(f.root, "workspace-0");
  for (let index = 0; index < 64; index++) {
    const workspace = join(f.root, `workspace-${index}`);
    await mkdir(workspace);
    await f.service.get("notifications.sound", { workspace });
  }
  const overflow = join(f.root, "workspace-overflow");
  await mkdir(overflow);
  await expect(f.service.get("notifications.sound", { workspace: overflow })).rejects.toMatchObject(
    { code: "limit" },
  );
  await f.service.set("notifications.sound", true, { kind: "workspace", workspace: first });
  expect(await f.service.get("notifications.sound", { workspace: first })).toMatchObject({
    value: true,
  });
});

test("a root replaced by an empty directory retains its original workspace settings and diagnostic", async () => {
  const f = await setup();
  await f.service.set("notifications.sound", true, { kind: "workspace", workspace: f.workspace });
  const target = join(f.root, "empty-target");
  await mkdir(target);
  await rename(f.workspace, join(f.root, "old-repo"));
  await symlink(target, f.workspace, "dir");
  await f.service.refresh({ kind: "workspace", workspace: f.workspace });
  const result = await f.service.read({
    keys: ["notifications.sound"],
    scope: { workspace: f.workspace },
  });
  expect(result.entries[0]).toMatchObject({ value: true });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "validation",
      message: "Workspace root changed during settings access",
    }),
  );
});

test("unchanged containment failures notify subscribers once across repeated reads", async () => {
  const f = await setup();
  await f.service.set("notifications.sound", true, { kind: "workspace", workspace: f.workspace });
  const notices: unknown[] = [];
  await f.service.subscribe(
    { keys: ["notifications.sound"], scope: { workspace: f.workspace } },
    (n) => notices.push(n),
  );
  const ace = join(f.workspace, ".ace");
  await rename(ace, join(f.workspace, "old-ace"));
  await symlink(f.dataDir, ace, "dir");
  for (let count = 0; count < 2; count++)
    await f.service.read({ keys: ["notifications.sound"], scope: { workspace: f.workspace } });
  expect(notices).toEqual([
    {
      type: "diagnostic",
      diagnostic: expect.objectContaining({ code: "validation", layer: "workspace" }),
    },
  ]);
});

test("a cold workspace read cannot migrate an aliased global file outside the workspace", async () => {
  const f = await setup();
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const path = join(outside, "settings.json");
  const source = '{"version":1,"values":{"notifications.sound":true}}';
  await writeFile(path, source);
  const ace = join(f.workspace, ".ace");
  await symlink(outside, ace, "dir");
  const service = new SettingsService({
    dataDir: ace,
    io: f.edges.io,
    scheduler: f.edges.scheduler,
  });
  cleanups.push(() => service.close());
  const result = await service.read({
    keys: ["notifications.sound"],
    scope: { workspace: f.workspace },
  });
  expect(result.entries[0]).toMatchObject({ value: false, provenance: "defaults" });
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "validation", layer: "workspace" }),
  );
  expect(await readFile(path, "utf8")).toBe(source);
});

test("global aliases retain workspace containment after physical file eviction", async () => {
  const f = await setup();
  const ace = join(f.workspace, ".ace");
  await mkdir(ace);
  const service = new SettingsService({
    dataDir: ace,
    io: f.edges.io,
    scheduler: f.edges.scheduler,
  });
  cleanups.push(() => service.close());
  await service.get("notifications.sound", { workspace: f.workspace });
  // Thread-only assignments do not acquire the global file, allowing its inactive lease to evict.
  for (let index = 0; index < 80; index++)
    await service.set("notifications.sound", false, {
      kind: "thread",
      thread: `inactive-${index}`,
    });
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const path = join(outside, "settings.json");
  const source = '{"version":1,"values":{"notifications.sound":true}}';
  await writeFile(path, source);
  await rename(ace, join(f.workspace, "old-ace"));
  await symlink(outside, ace, "dir");
  await service.refresh({ kind: "global" });
  const result = await service.read({ keys: ["notifications.sound"], scope: {} });
  expect(result.entries[0]).toMatchObject({ value: false, provenance: "defaults" });
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "validation" }));
  await expect(service.set("notifications.sound", false, { kind: "global" })).rejects.toMatchObject(
    {
      code: "validation",
    },
  );
  expect(await readFile(path, "utf8")).toBe(source);
});
