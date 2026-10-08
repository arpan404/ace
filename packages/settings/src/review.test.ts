import { mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SettingsService, atomicWrite, fileIO, type Notification } from "./index.ts";
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

test("duplicate JSONC assignments fail with a diagnostic and retain the last good document", async () => {
  const f = await setup();
  await f.service.set("threads.settleOnClose", true, { kind: "global" });
  const source =
    '{"version":2,"settings":{"threads.settleOnClose":false,"threads.settleOnClose":false}}';
  await writeFile(f.globalPath, source);
  await f.service.refresh({ kind: "global" });
  const result = await f.service.read({ keys: ["threads.settleOnClose"], scope: {} });
  expect(result.entries[0]).toMatchObject({ value: true });
  expect(result.diagnostics[0]).toMatchObject({
    code: "validation",
    message: "Duplicate JSONC property",
  });
  await expect(f.service.set("threads.settleOnClose", false, { kind: "global" })).rejects.toThrow(
    "Duplicate",
  );
  expect(await readFile(f.globalPath, "utf8")).toBe(source);
});

test.each([
  '{"future":{"apiToken":"sensitive"},"future":{}}',
  '{"future":"sk\\u002d1234567890abcdefgh","future":"safe"}',
  '{"clients.theme":{"__proto__":{"password":"sensitive"}}}',
  '{"__proto__":{"threads.settleOnClose":true}}',
  '{"future":{"constructor":{}}}',
  '{"future":{"passwd":"sensitive"}}',
])(
  "every decoded property and string is checked before JSONC materialization: %s",
  async (settings) => {
    const f = await setup();
    const source = `{"version":2,"settings":${settings}}`;
    await writeFile(f.globalPath, source);
    const result = await f.service.read({ keys: ["threads.settleOnClose"], scope: {} });
    expect(result.entries[0]).toMatchObject({ value: false, provenance: "defaults" });
    expect(result.diagnostics[0]).toMatchObject({ code: "secret" });
    await expect(f.service.set("remote.enabled", true, { kind: "global" })).rejects.toMatchObject({
      code: "secret",
    });
    expect(await readFile(f.globalPath, "utf8")).toBe(source);
    expect(JSON.stringify(result.diagnostics)).not.toContain("sensitive");
  },
);

test("a workspace symlink cannot overwrite global settings", async () => {
  const f = await setup();
  await f.service.set("threads.followUpBehavior", "queue", { kind: "global" });
  await symlink(f.dataDir, join(f.workspace, ".ace"), "dir");
  await expect(
    f.service.set("threads.followUpBehavior", "steer", {
      kind: "workspace",
      workspace: f.workspace,
    }),
  ).rejects.toMatchObject({ code: "validation" });
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "threads.followUpBehavior": "queue" },
  });
  await f.service.refresh({ kind: "global" });
  expect(await f.service.get("threads.followUpBehavior")).toMatchObject({
    value: "queue",
    provenance: "global",
  });
});

test("a workspace directory changed to an escaping symlink during a write cannot publish globally", async () => {
  const f = await setup();
  await f.service.set("threads.followUpBehavior", "queue", { kind: "global" });
  const ace = join(f.workspace, ".ace");
  await mkdir(ace);
  const raced = new SettingsService({
    dataDir: f.dataDir,
    io: {
      ...fileIO,
      watch: async () => () => {},
      write: (path, text, beforeCommit) =>
        atomicWrite(path, text, async () => {
          await rename(ace, join(f.workspace, "old-ace"));
          await symlink(f.dataDir, ace, "dir");
          await beforeCommit?.();
        }),
    },
  });
  cleanups.push(() => raced.close());
  await expect(
    raced.set("threads.followUpBehavior", "steer", { kind: "workspace", workspace: f.workspace }),
  ).rejects.toMatchObject({ code: "validation" });
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "threads.followUpBehavior": "queue" },
  });
  expect(await readdir(join(f.workspace, "old-ace"))).toEqual([]);
});

test("watch installation failures remain visible after valid reads and retry registration", async () => {
  const f = await setup();
  let broken = true;
  const service = new SettingsService({
    dataDir: f.dataDir,
    scheduler: f.edges.scheduler,
    io: {
      ...f.edges.io,
      watch: async (...args) => {
        if (broken) throw new Error("injected watch failure");
        return f.edges.io.watch(...args);
      },
    },
  });
  cleanups.push(() => service.close());
  await f.write(f.globalPath, { "threads.settleOnClose": true });
  const result = await service.read({ keys: ["threads.settleOnClose"], scope: {} });
  expect(result.entries[0]).toMatchObject({ value: true });
  expect(result.diagnostics[0]).toMatchObject({ code: "io", message: "Settings watcher failed" });
  broken = false;
  f.edges.flush();
  await service.settled({ kind: "global" });
  expect((await service.read({ keys: ["threads.settleOnClose"], scope: {} })).diagnostics).toEqual(
    [],
  );
  const notices: Notification[] = [];
  await service.subscribe({ keys: ["threads.settleOnClose"], scope: {} }, (n) => notices.push(n));
  await f.write(f.globalPath, { "threads.settleOnClose": false });
  f.edges.changed(f.globalPath);
  f.edges.flush();
  await service.settled({ kind: "global" });
  expect(notices).toEqual([
    {
      type: "changed",
      entries: [{ key: "threads.settleOnClose", value: false, provenance: "global" }],
    },
  ]);
  await f.write(f.globalPath, { "threads.settleOnClose": true });
  f.edges.changed(f.globalPath);
  f.edges.flush();
  await service.settled({ kind: "global" });
  expect(notices).toHaveLength(2);
  expect(notices[1]).toMatchObject({
    type: "changed",
    entries: [{ key: "threads.settleOnClose", value: true, provenance: "global" }],
  });
});

test("physical file aliases retain the layer provenance selected by the scope", async () => {
  const f = await setup();
  const dataDir = join(f.workspace, ".ace");
  await mkdir(dataDir);
  await f.write(join(dataDir, "settings.json"), { "threads.settleOnClose": true });
  const service = new SettingsService({ dataDir, io: f.edges.io, scheduler: f.edges.scheduler });
  cleanups.push(() => service.close());
  expect(await service.get("threads.settleOnClose")).toMatchObject({
    value: true,
    provenance: "global",
  });
  expect(await service.get("threads.settleOnClose", { workspace: f.workspace })).toMatchObject({
    value: true,
    provenance: "workspace",
  });
});

test("inactive scopes release capacity while subscriptions keep their scopes live", async () => {
  const f = await setup();
  const notices: Notification[] = [];
  await f.service.set("threads.settleOnClose", true, { kind: "thread", thread: "pinned" });
  await f.service.subscribe({ keys: ["threads.settleOnClose"], scope: { thread: "pinned" } }, (n) =>
    notices.push(n),
  );
  for (let index = 0; index < 100; index++)
    expect(
      await f.service.get("threads.settleOnClose", { thread: `inactive-${index}` }),
    ).toMatchObject({ value: false });
  await f.service.set("threads.settleOnClose", false, { kind: "thread", thread: "pinned" });
  expect(notices).toEqual([
    {
      type: "changed",
      entries: [{ key: "threads.settleOnClose", value: false, provenance: "thread" }],
    },
  ]);
});

test("cached scalar edits track shifted Unicode offsets and fully revalidate external changes", async () => {
  const f = await setup();
  await writeFile(
    f.globalPath,
    '{"version":2,"settings":{"providers.coder.model":"🚀","threads.settleOnClose":false,"future.payload":"kept"}}',
  );
  await f.service.set("providers.coder.model", "longer-model", { kind: "global" });
  await f.service.set("threads.settleOnClose", true, { kind: "global" });
  await f.service.set("providers.coder.model", "é", { kind: "global" });
  await f.service.set("threads.settleOnClose", false, { kind: "global" });
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: {
      "providers.coder.model": "é",
      "threads.settleOnClose": false,
      "future.payload": "kept",
    },
  });
  await writeFile(
    f.globalPath,
    '{"version":2,"settings":{"threads.settleOnClose":false,"threads.settleOnClose":true}}',
  );
  await expect(
    f.service.set("threads.settleOnClose", true, { kind: "global" }),
  ).rejects.toMatchObject({ code: "validation" });
  expect(await f.service.get("providers.coder.model")).toMatchObject({ value: "é" });
});
