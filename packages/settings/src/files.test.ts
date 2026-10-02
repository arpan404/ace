import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { atomicWrite, fileIO, scheduler, MAX_DOCUMENT_BYTES, type Notification } from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function gate() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: () => {
      resolve?.();
    },
  };
}

test("ace rereads earlier external edits and the last rename wins without torn files", async () => {
  const entered = gate();
  const release = gate();
  let intercept = false;
  const f = await fixture({
    io: {
      ...fileIO,
      watch: async () => () => {},
      write: async (path, text) =>
        atomicWrite(path, text, async () => {
          if (intercept) {
            entered.resolve();
            await release.promise;
          }
        }),
    },
  });
  cleanups.push(() => f.close());
  await f.service.set("notifications.sound", true, { kind: "global" });
  await f.write(f.globalPath, { "notifications.sound": true, "future.before": "retained" });
  intercept = true;
  const writing = f.service.set("notifications.sound", false, { kind: "global" });
  await entered.promise;
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "notifications.sound": true, "future.before": "retained" },
  });
  await atomicWrite(
    f.globalPath,
    JSON.stringify({
      version: 2,
      settings: { "notifications.sound": true, "future.during": "external" },
    }),
  );
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "future.during": "external" },
  });
  release.resolve();
  await writing;
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toEqual({
    version: 2,
    settings: { "notifications.sound": false, "future.before": "retained" },
  });
  expect(await readdir(f.dataDir)).toEqual(["settings.json"]);
  await atomicWrite(
    f.globalPath,
    JSON.stringify({
      version: 2,
      settings: { "notifications.sound": true, "future.after": "wins" },
    }),
  );
  await f.service.refresh({ kind: "global" });
  expect(await f.service.get("notifications.sound")).toMatchObject({ value: true });
});

test("real watchers follow atomic replacements and a newly created workspace directory", async () => {
  const f = await fixture({ io: fileIO, scheduler });
  cleanups.push(() => f.close());
  const notices: Notification[] = [];
  let signal = gate();
  await f.service.subscribe(
    { keys: ["notifications.sound"], scope: { workspace: f.workspace } },
    (n) => {
      notices.push(n);
      signal.resolve();
    },
  );
  const workspacePath = join(f.workspace, ".ace", "settings.json");
  await atomicWrite(workspacePath, '{"version":2,"settings":{"notifications.sound":true}}');
  await signal.promise;
  expect(notices.at(-1)).toMatchObject({
    type: "changed",
    entries: [{ value: true, provenance: "workspace" }],
  });
  signal = gate();
  await atomicWrite(workspacePath, '{"version":2,"settings":{"notifications.sound":false}}');
  await signal.promise;
  expect(notices.at(-1)).toMatchObject({
    type: "changed",
    entries: [{ value: false, provenance: "workspace" }],
  });
  signal = gate();
  await unlink(workspacePath);
  await signal.promise;
  expect(notices.at(-1)).toMatchObject({
    type: "changed",
    entries: [{ value: false, provenance: "defaults" }],
  });
});

test("oversized files, deep JSON, invalid known values and credentials preserve the last good document", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.service.set("notifications.sound", true, { kind: "global" });
  for (const [text, code] of [
    [" ".repeat(MAX_DOCUMENT_BYTES + 1), "size"],
    ['{"version":2,"settings":{"future":' + "[".repeat(65) + "0" + "]".repeat(65) + "}}", "size"],
    ['{"version":2,"settings":{"notifications.sound":"false"}}', "validation"],
    ['{"version":2,"settings":{"future":{"apiToken":"sensitive"}}}', "secret"],
  ]) {
    if (text === undefined) throw new Error("Missing text");
    await writeFile(f.globalPath, text);
    await f.service.refresh({ kind: "global" });
    const result = await f.service.read({ keys: ["notifications.sound"], scope: {} });
    expect(result.entries[0]).toMatchObject({ value: true });
    expect(result.diagnostics[0]).toMatchObject({ code });
  }
});

test("serialized concurrent sets preserve both changes and close drains in-flight writes", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await Promise.all([
    f.service.set("notifications.sound", true, { kind: "global" }),
    f.service.set("remote.enabled", true, { kind: "global" }),
  ]);
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "notifications.sound": true, "remote.enabled": true },
  });
  await f.service.close();
  await expect(f.service.get("notifications.sound")).rejects.toThrow("closed");
});

test("listener failures cannot prevent other subscribers from seeing a committed write", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const notices: Notification[] = [];
  await f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, () => {
    throw new Error("listener failure");
  });
  await f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, (n) => notices.push(n));
  await f.service.set("notifications.sound", true, { kind: "global" });
  expect(notices).toHaveLength(1);
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "notifications.sound": true },
  });
});

test("failed atomic writes retain the destination and remove temporary siblings", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.write(f.globalPath, { "notifications.sound": true });
  await expect(
    atomicWrite(f.globalPath, "new", async () => {
      throw new Error("injected rename failure");
    }),
  ).rejects.toThrow("injected");
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "notifications.sound": true },
  });
  expect(await readdir(f.dataDir)).toEqual(["settings.json"]);
});

test("file and subscription capacity refuse growth and released subscriptions can be replaced", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.service.get("notifications.sound");
  const stops = await Promise.all(
    Array.from({ length: 1024 }, () =>
      f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, () => {}),
    ),
  );
  await expect(
    f.service.subscribe({ keys: ["notifications.sound"], scope: {} }, () => {}),
  ).rejects.toThrow("limit");
  for (const stop of stops) stop();
  const replacement = await f.service.subscribe(
    { keys: ["notifications.sound"], scope: {} },
    () => {},
  );
  replacement();
  for (let count = 0; count < 63; count++)
    await f.service.get("notifications.sound", { thread: `thread-${count}` });
  await expect(f.service.get("notifications.sound", { thread: "overflow" })).rejects.toThrow(
    "limit",
  );
  await expect(f.service.get("notifications.sound", { thread: "../escape" })).rejects.toThrow(
    "Invalid thread",
  );
  await mkdir(join(f.root, "unrelated"));
});

test("malformed UTF-8 edits produce a diagnostic without substituting replacement characters", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.service.set("notifications.sound", true, { kind: "global" });
  await writeFile(
    f.globalPath,
    Buffer.concat([
      Buffer.from('{"version":2,"settings":{"clients.theme":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]),
  );
  await f.service.refresh({ kind: "global" });
  const result = await f.service.read({ keys: ["notifications.sound"], scope: {} });
  expect(result.entries[0]).toMatchObject({ value: true });
  expect(result.diagnostics[0]).toMatchObject({
    code: "parse",
    message: "Settings file is not valid UTF-8",
  });
});
