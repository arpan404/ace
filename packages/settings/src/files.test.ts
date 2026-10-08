import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  atomicWrite,
  fileIO,
  scheduler,
  createFileWatcher,
  MAX_DOCUMENT_BYTES,
  type Notification,
} from "./index.ts";
import { fixture, ManualEdges } from "./test-support.ts";

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
  await f.service.set("threads.settleOnClose", true, { kind: "global" });
  await f.write(f.globalPath, { "threads.settleOnClose": true, "future.before": "retained" });
  intercept = true;
  const writing = f.service.set("threads.settleOnClose", false, { kind: "global" });
  try {
    await entered.promise;
    expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
      settings: { "threads.settleOnClose": true, "future.before": "retained" },
    });
    await atomicWrite(
      f.globalPath,
      JSON.stringify({
        version: 2,
        settings: { "threads.settleOnClose": true, "future.during": "external" },
      }),
    );
    expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
      settings: { "future.during": "external" },
    });
  } finally {
    release.resolve();
    await writing;
  }
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toEqual({
    version: 2,
    settings: { "threads.settleOnClose": false, "future.before": "retained" },
  });
  expect(await readdir(f.dataDir)).toEqual(["settings.json"]);
  await atomicWrite(
    f.globalPath,
    JSON.stringify({
      version: 2,
      settings: { "threads.settleOnClose": true, "future.after": "wins" },
    }),
  );
  await f.service.refresh({ kind: "global" });
  expect(await f.service.get("threads.settleOnClose")).toMatchObject({ value: true });
});

test("real watchers follow atomic replacements and a newly created workspace directory", async () => {
  const f = await fixture({ io: fileIO, scheduler });
  cleanups.push(() => f.close());
  const notices: Notification[] = [];
  let signal = gate();
  await f.service.subscribe(
    { keys: ["threads.settleOnClose"], scope: { workspace: f.workspace } },
    (n) => {
      notices.push(n);
      signal.resolve();
    },
  );
  const workspacePath = join(f.workspace, ".ace", "settings.json");
  await atomicWrite(workspacePath, '{"version":2,"settings":{"threads.settleOnClose":true}}');
  await signal.promise;
  expect(notices.at(-1)).toMatchObject({
    type: "changed",
    entries: [{ value: true, provenance: "workspace" }],
  });
  signal = gate();
  await atomicWrite(workspacePath, '{"version":2,"settings":{"threads.settleOnClose":false}}');
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

test("a missing workspace directory is reconciled when native ancestor notifications are lost", async () => {
  const edges = new ManualEdges();
  const polls = new Set<() => void>();
  const f = await fixture({
    io: {
      ...fileIO,
      watch: createFileWatcher(
        () => () => {},
        (_path, changed) => {
          polls.add(changed);
          return () => {
            polls.delete(changed);
          };
        },
      ),
    },
    scheduler: edges.scheduler,
  });
  cleanups.push(() => f.close());
  const notice = Promise.withResolvers<Notification>();
  await f.service.subscribe(
    { keys: ["threads.settleOnClose"], scope: { workspace: f.workspace } },
    notice.resolve,
  );
  await atomicWrite(
    join(f.workspace, ".ace", "settings.json"),
    '{"version":2,"settings":{"threads.settleOnClose":true}}',
  );
  for (const poll of polls) poll();
  edges.flush();
  expect(await notice.promise).toMatchObject({
    type: "changed",
    entries: [{ value: true, provenance: "workspace" }],
  });
});

test("oversized files, deep JSON, invalid known values and credentials preserve the last good document", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.service.set("threads.settleOnClose", true, { kind: "global" });
  for (const [text, code] of [
    [" ".repeat(MAX_DOCUMENT_BYTES + 1), "size"],
    ['{"version":2,"settings":{"future":' + "[".repeat(65) + "0" + "]".repeat(65) + "}}", "size"],
    ['{"version":2,"settings":{"threads.settleOnClose":"false"}}', "validation"],
    ['{"version":2,"settings":{"future":{"apiToken":"sensitive"}}}', "secret"],
  ]) {
    if (text === undefined) throw new Error("Missing text");
    await writeFile(f.globalPath, text);
    await f.service.refresh({ kind: "global" });
    const result = await f.service.read({ keys: ["threads.settleOnClose"], scope: {} });
    expect(result.entries[0]).toMatchObject({ value: true });
    expect(result.diagnostics[0]).toMatchObject({ code });
  }
});

test("serialized concurrent sets preserve both changes", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await Promise.all([
    f.service.set("threads.settleOnClose", true, { kind: "global" }),
    f.service.set("remote.enabled", true, { kind: "global" }),
  ]);
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "threads.settleOnClose": true, "remote.enabled": true },
  });
  await f.service.close();
  await expect(f.service.get("threads.settleOnClose")).rejects.toThrow("closed");
});

test("listener failures cannot prevent other subscribers from seeing a committed write", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  const notices: Notification[] = [];
  await f.service.subscribe({ keys: ["threads.settleOnClose"], scope: {} }, () => {
    throw new Error("listener failure");
  });
  await f.service.subscribe({ keys: ["threads.settleOnClose"], scope: {} }, (n) => notices.push(n));
  await f.service.set("threads.settleOnClose", true, { kind: "global" });
  expect(notices).toHaveLength(1);
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "threads.settleOnClose": true },
  });
});

test("failed atomic writes retain the destination and remove temporary siblings", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.write(f.globalPath, { "threads.settleOnClose": true });
  await expect(
    atomicWrite(f.globalPath, "new", async () => {
      throw new Error("injected rename failure");
    }),
  ).rejects.toThrow("injected");
  expect(JSON.parse(await readFile(f.globalPath, "utf8"))).toMatchObject({
    settings: { "threads.settleOnClose": true },
  });
  expect(await readdir(f.dataDir)).toEqual(["settings.json"]);
});

test("file and subscription capacity refuse growth and released subscriptions can be replaced", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.service.get("threads.settleOnClose");
  const stops = await Promise.all(
    Array.from({ length: 1024 }, () =>
      f.service.subscribe({ keys: ["threads.settleOnClose"], scope: {} }, () => {}),
    ),
  );
  await expect(
    f.service.subscribe({ keys: ["threads.settleOnClose"], scope: {} }, () => {}),
  ).rejects.toThrow("limit");
  for (const stop of stops) stop();
  const replacement = await f.service.subscribe(
    { keys: ["threads.settleOnClose"], scope: {} },
    () => {},
  );
  replacement();
  for (let count = 0; count < 63; count++)
    await f.service.subscribe(
      { keys: ["threads.settleOnClose"], scope: { thread: `thread-${count}` } },
      () => {},
    );
  await expect(f.service.get("threads.settleOnClose", { thread: "overflow" })).rejects.toThrow(
    "limit",
  );
  await expect(f.service.get("threads.settleOnClose", { thread: "../escape" })).rejects.toThrow(
    "Invalid thread",
  );
  await mkdir(join(f.root, "unrelated"));
});

test("malformed UTF-8 edits produce a diagnostic without substituting replacement characters", async () => {
  const f = await fixture();
  cleanups.push(() => f.close());
  await f.service.set("threads.settleOnClose", true, { kind: "global" });
  await writeFile(
    f.globalPath,
    Buffer.concat([
      Buffer.from('{"version":2,"settings":{"clients.theme":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]),
  );
  await f.service.refresh({ kind: "global" });
  const result = await f.service.read({ keys: ["threads.settleOnClose"], scope: {} });
  expect(result.entries[0]).toMatchObject({ value: true });
  expect(result.diagnostics[0]).toMatchObject({
    code: "parse",
    message: "Settings file is not valid UTF-8",
  });
});

test("missing settings parents cost only stat polls while idle and reconcile their first creation", async () => {
  const ticks = new Set<() => Promise<void>>();
  const reads: string[] = [];
  const edges = new ManualEdges();
  const f = await fixture({
    io: {
      ...fileIO,
      read: async (path) => {
        reads.push(path);
        return fileIO.read(path);
      },
      watch: createFileWatcher(
        () => () => {},
        undefined,
        (tick) => {
          ticks.add(tick);
          return () => {
            ticks.delete(tick);
          };
        },
      ),
    },
    scheduler: edges.scheduler,
  });
  cleanups.push(() => f.close());
  const notice = Promise.withResolvers<Notification>();
  await f.service.subscribe(
    { keys: ["threads.settleOnClose"], scope: { workspace: f.workspace, thread: "idle" } },
    notice.resolve,
  );
  const initialReads = reads.slice();
  for (let i = 0; i < 6; i++) {
    await Promise.all([...ticks].map((tick) => tick()));
    edges.flush();
  }
  expect(reads).toEqual(initialReads);
  await atomicWrite(
    join(f.workspace, ".ace", "settings.json"),
    '{"version":2,"settings":{"threads.settleOnClose":true}}',
  );
  await Promise.all([...ticks].map((tick) => tick()));
  edges.flush();
  expect(await notice.promise).toMatchObject({
    entries: [{ value: true, provenance: "workspace" }],
  });
});
