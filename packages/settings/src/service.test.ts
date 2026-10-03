import { parse } from "jsonc-parser";
import { readFile, writeFile, stat, unlink } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import { SettingsService, type Notification } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function setup() {
  const f = await fixture();
  cleanups.push(() => f.close());
  return f;
}

test("each key resolves from the highest present layer and reports its provenance", async () => {
  const f = await setup();
  const scope = { workspace: f.workspace, thread: "thread-1" };
  expect(await f.service.get("conductor.maxFixRounds", scope)).toEqual({
    key: "conductor.maxFixRounds",
    value: 3,
    provenance: "defaults",
  });
  await f.service.set("conductor.maxFixRounds", 4, { kind: "global" });
  await f.service.set("conductor.maxFixRounds", 5, { kind: "workspace", workspace: f.workspace });
  await f.service.set("conductor.maxFixRounds", 6, { kind: "thread", thread: "thread-1" });
  expect(await f.service.get("conductor.maxFixRounds", {})).toMatchObject({
    value: 4,
    provenance: "global",
  });
  expect(await f.service.get("conductor.maxFixRounds", { workspace: f.workspace })).toMatchObject({
    value: 5,
    provenance: "workspace",
  });
  expect(await f.service.get("conductor.maxFixRounds", scope)).toMatchObject({
    value: 6,
    provenance: "thread",
  });
  expect(await f.service.get("remote.enabled", scope)).toMatchObject({
    value: false,
    provenance: "defaults",
  });
  await f.service.close();
  const restarted = new SettingsService({ dataDir: f.dataDir, io: f.edges.io });
  cleanups.push(() => restarted.close());
  expect(await restarted.get("conductor.maxFixRounds", scope)).toMatchObject({
    value: 6,
    provenance: "thread",
  });
});

test("a v1 document migrates on read and is written back exactly once", async () => {
  const f = await setup();
  await writeFile(
    f.globalPath,
    '{\n // legacy preference\n "version": 1, "values": {"notifications.sound": true, "future.option": [1]}, "futureEnvelope": 42\n}',
  );
  expect(await f.service.get("notifications.sound")).toMatchObject({
    value: true,
    provenance: "global",
  });
  const text = await readFile(f.globalPath, "utf8");
  expect(JSON.parse(text.replace("// legacy preference", ""))).toEqual({
    version: 2,
    settings: { "notifications.sound": true, "future.option": [1] },
    futureEnvelope: 42,
  });
  expect(text).toContain("// legacy preference");
  const before = await stat(f.globalPath, { bigint: true });
  await f.service.refresh({ kind: "global" });
  const after = await stat(f.globalPath, { bigint: true });
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeNs).toBe(before.mtimeNs);
});

test("sets retain unknown fields, comments, trailing commas and local indentation", async () => {
  const f = await setup();
  const original =
    '{\r\n\t"version": 2,\r\n\t"other": {"newer": 9},\r\n\t"settings": {\r\n\t\t// keep this advice\r\n\t\t"notifications.sound": false, // inline\r\n\t\t"future.feature": {"enabled": true},\r\n\t},\r\n}\r\n';
  await writeFile(f.globalPath, original);
  await f.service.set("notifications.sound", true, { kind: "global" });
  expect(await readFile(f.globalPath, "utf8")).toBe(
    original.replace('"notifications.sound": false', '"notifications.sound": true'),
  );
  await f.service.set("remote.enabled", true, { kind: "global" });
  const text = await readFile(f.globalPath, "utf8");
  expect(parse(text)).toMatchObject({ settings: { "future.feature": { enabled: true } } });
  expect(text).toContain("// inline");
  expect(text).toContain('"other": {"newer": 9}');
});

test("invalid external edits retain the last good values, report diagnostics and block writes", async () => {
  const f = await setup();
  const notifications: Notification[] = [];
  await f.service.set("notifications.sound", true, { kind: "global" });
  await f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, (n) =>
    notifications.push(n),
  );
  await writeFile(f.globalPath, '{"version":2,"settings":');
  await f.service.refresh({ kind: "global" });
  expect(await f.service.get("notifications.sound")).toMatchObject({ value: true });
  expect(notifications).toEqual([
    expect.objectContaining({
      type: "diagnostic",
      diagnostic: expect.objectContaining({ code: "parse" }),
    }),
  ]);
  await expect(f.service.set("notifications.sound", false, { kind: "global" })).rejects.toThrow(
    "Invalid JSONC",
  );
  expect(await readFile(f.globalPath, "utf8")).toBe('{"version":2,"settings":');
  await f.write(f.globalPath, { "notifications.sound": false });
  await f.service.refresh({ kind: "global" });
  expect((await f.service.read({ keys: ["notifications.sound"], scope: {} })).diagnostics).toEqual(
    [],
  );
  expect(await f.service.get("notifications.sound")).toMatchObject({ value: false });
});

test("subscriptions ignore unrelated keys, unchanged assignments and shadowed changes", async () => {
  const f = await setup();
  const global: Notification[] = [];
  const workspace: Notification[] = [];
  await f.service.set("notifications.sound", true, { kind: "workspace", workspace: f.workspace });
  const stop = await f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, (n) =>
    global.push(n),
  );
  await f.service.subscribe(
    { keys: ["notifications.sound"], scope: { workspace: f.workspace } },
    (n) => workspace.push(n),
  );
  await f.service.set("remote.enabled", true, { kind: "global" });
  expect(global).toEqual([]);
  expect(workspace).toEqual([]);
  await f.service.set("notifications.sound", true, { kind: "global" });
  expect(global).toEqual([
    {
      type: "changed",
      entries: [{ key: "notifications.sound", value: true, provenance: "global" }],
    },
  ]);
  expect(workspace).toEqual([]);
  await f.service.set("notifications.sound", true, { kind: "global" });
  expect(global).toHaveLength(1);
  stop();
  await f.service.set("notifications.sound", false, { kind: "global" });
  expect(global).toHaveLength(1);
});

test("file deletion reports a provenance change even when the fallback value is equal", async () => {
  const f = await setup();
  const notices: Notification[] = [];
  await f.service.set("notifications.sound", false, { kind: "global" });
  await f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, (n) => notices.push(n));
  await unlink(f.globalPath);
  await f.service.refresh({ kind: "global" });
  expect(notices).toEqual([
    {
      type: "changed",
      entries: [{ key: "notifications.sound", value: false, provenance: "defaults" }],
    },
  ]);
});

test("a watcher burst produces one diagnostic after its debounce boundary", async () => {
  const f = await setup();
  const notices: Notification[] = [];
  let resolveDiagnostic: (() => void) | undefined;
  const observed = new Promise<void>((resolve) => {
    resolveDiagnostic = resolve;
  });
  await f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, (n) => {
    notices.push(n);
    resolveDiagnostic?.();
  });
  await writeFile(f.globalPath, "invalid");
  for (let count = 0; count < 20; count++) f.edges.changed(f.globalPath);
  expect(notices).toEqual([]);
  f.edges.flush();
  await observed;
  await f.service.settled({ kind: "global" });
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ type: "diagnostic" });
});

test("secret-looking fields and values are rejected without echoing their contents", async () => {
  const f = await setup();
  for (const value of [
    { apiToken: "sensitive" },
    { nested: { password: "sensitive" } },
    { apiKey: "sensitive" },
    { key: "sensitive" },
    { passwd: "sensitive" },
    { auth: "Bearer sensitive-value" },
    { provider: "sk-1234567890abcdefgh" },
  ]) {
    const assignment = f.service.set("plugins.preferences", value, { kind: "global" });
    await expect(assignment).rejects.toThrow(/Secret|Credentials/);
    await expect(assignment).rejects.toMatchObject({
      code: "secret",
      message: expect.not.stringMatching(/sensitive|1234567890abcdefgh/),
    });
  }
  await expect(readFile(f.globalPath)).rejects.toMatchObject({ code: "ENOENT" });
  await f.service.set("clients.keybindings", { save: "cmd+s" }, { kind: "global" });
  expect(await f.service.get("clients.keybindings")).toMatchObject({ value: { save: "cmd+s" } });
});

test("oversized blobs, invalid values and future documents do not replace valid settings", async () => {
  const f = await setup();
  await expect(
    f.service.set("clients.theme", "x".repeat(65536), { kind: "global" }),
  ).rejects.toThrow("64 KiB");
  await expect(f.service.set("conductor.maxFixRounds", -1, { kind: "global" })).rejects.toThrow(
    "Invalid value",
  );
  await f.service.set("notifications.sound", true, { kind: "global" });
  await writeFile(f.globalPath, '{"version":3,"settings":{"notifications.sound":false}}');
  await f.service.refresh({ kind: "global" });
  expect(await f.service.get("notifications.sound")).toMatchObject({ value: true });
  expect(
    (await f.service.read({ keys: ["notifications.sound"], scope: {} })).diagnostics[0],
  ).toMatchObject({ code: "version" });
  await expect(f.service.set("notifications.sound", false, { kind: "global" })).rejects.toThrow(
    "Unsupported",
  );
});

test("an external document change emits only the selected changed keys in one notification", async () => {
  const f = await setup();
  const notices: Notification[] = [];
  await f.service.subscribe(
    { keys: ["notifications.sound", "remote.enabled", "conductor.maxFixRounds"], scope: {} },
    (n) => notices.push(n),
  );
  await f.write(f.globalPath, {
    "notifications.sound": true,
    "remote.enabled": true,
    "future.setting": "newer",
  });
  await f.service.refresh({ kind: "global" });
  expect(notices).toEqual([
    {
      type: "changed",
      entries: [
        { key: "notifications.sound", value: true, provenance: "global" },
        { key: "remote.enabled", value: true, provenance: "global" },
      ],
    },
  ]);
});
