import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { workspaceRuntime } from "@ace/workspace";
import { ThreadId, type FilesServerMessage } from "@ace/protocol";
import {
  attachFilesChannel,
  chunkFilesChannel,
  createExclusiveRename,
  FileError,
} from "./index.ts";
import { fixture } from "./test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup(options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(options);
  cleanup.push(() => f.close());
  return f;
}
async function version(f: Awaited<ReturnType<typeof setup>>, path: string) {
  return z
    .object({ version: z.string() })
    .parse(await f.service.request("writer", { op: "stat", path })).version;
}

test("trash stays on the workspace volume and restores the exact bytes after restart", async () => {
  const mover = createExclusiveRename();
  cleanup.push(() => mover.close());
  const f = await setup({
    exclusiveRename: {
      async move(source, destination) {
        if (dirname(source) !== dirname(destination)) throw new FileError("EXDEV", "Other volume");
        await mover.move(source, destination);
      },
      close: async () => {},
    },
  });
  await writeFile(join(f.root, "file"), "recover me");
  const deleted = z.object({ trashId: z.string() }).parse(
    await f.service.request("writer", {
      op: "delete",
      path: "file",
      expected: await version(f, "file"),
    }),
  );
  await expect(readFile(join(f.root, "file"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    z
      .object({ paths: z.array(z.string()) })
      .parse(await f.service.request("writer", { op: "list", path: "", limit: 100 })).paths,
  ).toEqual([]);
  await f.restart();
  await f.service.request("writer", {
    op: "restore",
    path: "file",
    expected: null,
    trashId: deleted.trashId,
  });
  expect(await readFile(join(f.root, "file"), "utf8")).toBe("recover me");
});

test("a crashed rename worker fails its current move and the next move starts a healthy worker", async () => {
  let first = true;
  const mover = createExclusiveRename(() => {
    if (first) {
      first = false;
      return new Worker("throw new Error('fixture failure')", { eval: true });
    }
    return new Worker(new URL("./rename-worker.ts", import.meta.url), { execArgv: [] });
  });
  const f = await setup({ exclusiveRename: mover });
  await writeFile(join(f.root, "source"), "unchanged");
  const operation = {
    op: "rename",
    path: "source",
    destination: "destination",
    destinationExpected: null,
    expected: await version(f, "source"),
  };
  await expect(f.service.request("writer", operation)).rejects.toThrow();
  expect(await readFile(join(f.root, "source"), "utf8")).toBe("unchanged");
  await f.service.request("writer", operation);
  expect(await readFile(join(f.root, "destination"), "utf8")).toBe("unchanged");
});

test.each(["legacy", "chunks"] as const)(
  "expired %s downloads release transfer slots while their socket stays connected",
  async (mode) => {
    const deadlines = new Set<() => void>();
    const f = await setup({
      scheduleTimeout(callback) {
        deadlines.add(callback);
        return () => {
          deadlines.delete(callback);
        };
      },
    });
    await writeFile(join(f.root, "file"), "bytes");
    let waiter = Promise.withResolvers<FilesServerMessage>();
    const queued: FilesServerMessage[] = [];
    const receive = () => {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      return waiter.promise.then((received) => {
        waiter = Promise.withResolvers<FilesServerMessage>();
        return received;
      });
    };
    const channel =
      mode === "legacy"
        ? attachFilesChannel(
            f.service,
            {
              isOpen: true,
              bufferedBytes: 0,
              async sendControl(message) {
                if (queued.length || !waiting) queued.push(message);
                else {
                  waiting = false;
                  waiter.resolve(message);
                }
              },
              async sendBinary() {},
              onClose: () => () => {},
              close() {},
            },
            "writer",
          )
        : chunkFilesChannel({
            device: "writer",
            resolve: async () => ({ service: f.service, allowed: () => true }),
            send(message) {
              if (queued.length || !waiting) queued.push(message);
              else {
                waiting = false;
                waiter.resolve(message);
              }
            },
          });
    let waiting = false;
    const next = () => {
      if (queued.length) return receive();
      waiting = true;
      return receive();
    };
    for (let n = 0; n < 4; n++) {
      channel.accept({
        type: "files.request",
        requestId: `download-${n}`,
        threadId: ThreadId.parse("fixture"),
        operation: { op: "download", path: "file", offset: 0 },
      });
      expect(await next()).toMatchObject({ type: "files.ready" });
    }
    channel.accept({
      type: "files.request",
      requestId: "blocked",
      threadId: ThreadId.parse("fixture"),
      operation: { op: "download", path: "file", offset: 0 },
    });
    expect(await next()).toMatchObject({ type: "files.error", code: "BUSY" });
    for (const expire of deadlines) expire();
    let released = 0;
    while (released < 4) {
      const message = await next();
      if (message.type === "files.cancelled") released++;
    }
    channel.accept({
      type: "files.request",
      requestId: "next",
      threadId: ThreadId.parse("fixture"),
      operation: { op: "download", path: "file", offset: 0 },
    });
    expect(await next()).toMatchObject({ type: "files.ready" });
    channel.close();
  },
);

test.each(["archive.preview", "delete"] as const)(
  "a %s walk leaves writes available and stops at its deadline",
  async (op) => {
    const runtime = workspaceRuntime();
    const filesystem = runtime.filesystem;
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let blocked = false;
    let timeout: (() => void) | undefined;
    const f = await setup({
      workspaceRuntime: runtime,
      scheduleTimeout(callback, milliseconds) {
        if (milliseconds === 30_000) timeout = callback;
        return () => {};
      },
    });
    await mkdir(join(f.root, "dir"));
    await writeFile(join(f.root, "dir", "file"), "bytes");
    const expected = await version(f, "dir");
    const original = filesystem.realpath;
    runtime.filesystem = {
      ...filesystem,
      async realpath(path) {
        if (path === join(f.root, "dir") && !blocked) {
          blocked = true;
          entered.resolve();
          await gate.promise;
        }
        return original(path);
      },
    };
    // SafeRoot captured its filesystem object, so intercept the same I/O object.
    filesystem.realpath = runtime.filesystem.realpath;
    const pending = f.service.request(
      "writer",
      op === "delete" ? { op, path: "dir", expected } : { op, path: "dir", includeIgnored: true },
    );
    const failed = expect(pending).rejects.toThrow();
    await entered.promise;
    const expire = timeout;
    await f.service.request("writer", {
      op: "create",
      path: "other",
      expected: null,
      text: "available",
    });
    expect(await readFile(join(f.root, "other"), "utf8")).toBe("available");
    expire?.();
    gate.resolve();
    await failed;
    filesystem.realpath = original;
    expect(await readFile(join(f.root, "dir", "file"), "utf8")).toBe("bytes");
  },
);

test("directory deletion rechecks agent edits after a failed queued write", async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<void>();
  let readingDelete = false;
  const mover = createExclusiveRename();
  cleanup.push(() => mover.close());
  const f = await setup({
    scheduleTimeout() {
      return () => {
        if (readingDelete) prepared.resolve();
      };
    },
    exclusiveRename: {
      async move(source, destination) {
        if (destination.endsWith("/blocked")) {
          entered.resolve();
          await gate.promise;
          throw new FileError("IO_ERROR", "Fixture write failed");
        }
        await mover.move(source, destination);
      },
      close: async () => {},
    },
  });
  await mkdir(join(f.root, "dir"));
  await writeFile(join(f.root, "dir", "file"), "before");
  const expected = await version(f, "dir");
  const blocker = expect(
    f.service.request("writer", { op: "create", path: "blocked", expected: null, text: "fixture" }),
  ).rejects.toThrow("Fixture write failed");
  await entered.promise;
  readingDelete = true;
  const deletion = expect(
    f.service.request("writer", { op: "delete", path: "dir", expected }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  try {
    await prepared.promise;
    await writeFile(join(f.root, "dir", "file"), "agent edit");
  } finally {
    gate.resolve();
  }
  await blocker;
  await deletion;
  expect(await readFile(join(f.root, "dir", "file"), "utf8")).toBe("agent edit");
});
