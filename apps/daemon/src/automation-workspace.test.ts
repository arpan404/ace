import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { AutomationEvent } from "@ace/protocol";
import { FilesRequestError, type EventPayload } from "@ace/files-native";
import { automationWorkspace } from "./automation-workspace.ts";
import type { ServiceContext } from "./services/types.ts";

const exec = promisify(execFile);

function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  return (async () => {
    while (!condition()) {
      if (Date.now() > end) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })();
}

/**
 * A checkout the test controls: each path's listing version and its bytes, behind a watch whose
 * batches the test sends itself. A digest is the contents, which is all a comparison needs.
 */
function fakeCheckout(
  versions: Map<string, { size: number; mtime: number }>,
  contents: Map<string, string>,
) {
  let listener: ((payload: EventPayload) => void) | undefined;
  const entries = () =>
    [...versions].map(([path, entry]) => ({
      name: path.split("/").at(-1) ?? path,
      path,
      kind: "file" as const,
      size: entry.size,
      mtimeMs: entry.mtime,
      ignored: false,
    }));
  const tool = {
    watch: async (_path: string, onBatch: (payload: EventPayload) => void) => {
      listener = onBatch;
      return async () => {};
    },
    listFolder: async () => ({
      entries: entries(),
      nextCursor: null,
      total: versions.size,
    }),
    run: async <T>(
      _path: string,
      task: (client: {
        stat: (
          root: number,
          path: string,
        ) => Promise<{
          path: string;
          kind: { type: string };
          size: number;
          mtimeMs: number;
        }>;
        fingerprint: (
          root: number,
          path: string,
        ) => Promise<{ version: string; size: number; digest: string }>;
      }) => Promise<T>,
    ): Promise<T> =>
      task({
        stat: async (_root, path) => {
          const entry = versions.get(path);
          if (!entry) throw new FilesRequestError("NOT_FOUND", `${path} is gone`);
          return { path, kind: { type: "file" }, size: entry.size, mtimeMs: entry.mtime };
        },
        fingerprint: async (_root, path) => {
          const entry = versions.get(path);
          const digest = contents.get(path);
          if (!entry || digest === undefined)
            throw new FilesRequestError("NOT_FOUND", `${path} is gone`);
          return { version: `${entry.size}:${entry.mtime}`, size: entry.size, digest };
        },
      }),
  };
  return { tool, send: (payload: EventPayload) => listener?.(payload) };
}

test("a file trigger fires for matching non-ignored changes and reconciles a rescan", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    await exec("git", ["init", "--quiet", root]);
    await writeFile(join(root, ".gitignore"), "build/\n*.log\n");
    await mkdir(join(root, "build"));
    let listener: ((payload: EventPayload) => void) | undefined;
    let disposed = 0;
    // The checkout's versions, shared by the listing and the stat so a save moves one version.
    const versions = new Map([["src/a.ts", { size: 1, mtime: 1 }]]);
    const entries = () =>
      [...versions].map(([path, entry]) => ({
        name: path.split("/").at(-1) ?? path,
        path,
        kind: "file" as const,
        size: entry.size,
        mtimeMs: entry.mtime,
        ignored: false,
      }));
    const tool = {
      watch: async (_path: string, onBatch: (payload: EventPayload) => void) => {
        listener = onBatch;
        return async () => {
          disposed++;
        };
      },
      listFolder: async () => ({ entries: entries(), nextCursor: null, total: versions.size }),
      run: async <T>(
        _path: string,
        task: (client: {
          stat: (
            root: number,
            path: string,
          ) => Promise<{
            path: string;
            kind: { type: string };
            size: number;
            mtimeMs: number;
          }>;
          fingerprint: (
            root: number,
            path: string,
          ) => Promise<{ version: string; size: number; digest: string }>;
        }) => Promise<T>,
      ): Promise<T> =>
        task({
          stat: async (_root, path) => {
            const entry = versions.get(path);
            if (!entry) throw new FilesRequestError("NOT_FOUND", `${path} is gone`);
            return { path, kind: { type: "file" }, size: entry.size, mtimeMs: entry.mtime };
          },
          fingerprint: async (_root, path) => {
            const entry = versions.get(path);
            if (!entry) throw new FilesRequestError("NOT_FOUND", `${path} is gone`);
            return { version: `${entry.size}:${entry.mtime}`, size: entry.size, digest: path };
          },
        }),
    };
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool } },
    } as unknown as ServiceContext;
    const received: AutomationEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(context).subscribe(
      root,
      ["src/**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    await ready.promise;
    // A save moves the file's version before the watcher's batch names it.
    versions.set("src/a.ts", { size: 2, mtime: 2 });
    listener?.({
      type: "changes",
      changes: [
        { path: "src/a.ts", kind: "modified", directory: false },
        { path: "build/out.js", kind: "created", directory: false },
        { path: "docs/b.ts", kind: "created", directory: false },
        { path: "src/error.log", kind: "created", directory: false },
      ],
    });
    await until(() => received.length === 1);
    expect(received[0]?.variables).toMatchObject({
      path: "src/a.ts",
      kind: "changed",
      count: "1",
    });

    versions.set("src/b.ts", { size: 1, mtime: 1 });
    listener?.({ type: "rescan" });
    await until(() => received.length === 2);
    expect(received[1]?.variables).toMatchObject({ path: "src/b.ts", kind: "created" });
    dispose();
    await until(() => disposed === 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an event that lands while the baseline is read is delivered once, after ready", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    const order: string[] = [];
    let listener: ((payload: EventPayload) => void) | undefined;
    const versions = new Map([
      ["src/main.ts", { size: 1, mtime: 1 }],
      ["src/late.ts", { size: 2, mtime: 2 }],
    ]);
    let announced = false;
    const tool = {
      watch: async (_path: string, onBatch: (payload: EventPayload) => void) => {
        listener = onBatch;
        return async () => {};
      },
      listFolder: async () => {
        // The watcher reports a create while the baseline is still being read, and the walk
        // that builds the baseline already sees the file. It reports it once: a later listing
        // (a rescan) is not a new change.
        if (!announced) {
          announced = true;
          listener?.({
            type: "changes",
            changes: [{ path: "src/late.ts", kind: "created", directory: false }],
          });
        }
        return {
          entries: [...versions].map(([path, entry]) => ({
            name: path.split("/").at(-1) ?? path,
            path,
            kind: "file" as const,
            size: entry.size,
            mtimeMs: entry.mtime,
            ignored: false,
          })),
          nextCursor: null,
          total: versions.size,
        };
      },
      run: async <T>(
        _path: string,
        task: (client: {
          stat: (
            root: number,
            path: string,
          ) => Promise<{
            path: string;
            kind: { type: string };
            size: number;
            mtimeMs: number;
          }>;
          fingerprint: (
            root: number,
            path: string,
          ) => Promise<{ version: string; size: number; digest: string }>;
        }) => Promise<T>,
      ): Promise<T> =>
        task({
          stat: async (_root, path) => {
            const entry = versions.get(path);
            if (!entry) throw new FilesRequestError("NOT_FOUND", `${path} is gone`);
            return { path, kind: { type: "file" }, size: entry.size, mtimeMs: entry.mtime };
          },
          fingerprint: async (_root, path) => {
            const entry = versions.get(path);
            if (!entry) throw new FilesRequestError("NOT_FOUND", `${path} is gone`);
            return { version: `${entry.size}:${entry.mtime}`, size: entry.size, digest: path };
          },
        }),
    };
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool } },
    } as unknown as ServiceContext;
    const dispose = automationWorkspace(context).subscribe(
      root,
      ["src/**"],
      async (event) => {
        order.push(`${event.variables.kind}:${event.variables.path}`);
      },
      { onReady: () => order.push("ready") },
    );
    await until(() => order.includes("ready") && order.includes("created:src/late.ts"));
    expect(order).toEqual(["ready", "created:src/late.ts"]);

    // The replayed create moved the baseline, so a rescan has nothing to report again.
    listener?.({ type: "rescan" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(["ready", "created:src/late.ts"]);
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rescan detects a same-size edit whose modification time was put back", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    const versions = new Map([["src/a.ts", { size: 4, mtime: 10 }]]);
    const contents = new Map([["src/a.ts", "aaaa"]]);
    const files = fakeCheckout(versions, contents);
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool: files.tool } },
    } as unknown as ServiceContext;
    const received: AutomationEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(context).subscribe(
      root,
      ["src/**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    await ready.promise;

    // The edit keeps the size and puts every time back: the listing version is identical, so only
    // the bytes say that the file changed while nothing was watching.
    contents.set("src/a.ts", "bbbb");
    files.send({ type: "rescan" });
    await until(() => received.length === 1);
    expect(received[0]?.variables).toMatchObject({
      path: "src/a.ts",
      kind: "changed",
      count: "1",
    });
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live modification is reported even when its version equals the baseline", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    const versions = new Map([["src/a.ts", { size: 4, mtime: 10 }]]);
    const contents = new Map([["src/a.ts", "aaaa"]]);
    const files = fakeCheckout(versions, contents);
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool: files.tool } },
    } as unknown as ServiceContext;
    const received: AutomationEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(context).subscribe(
      root,
      ["src/**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    await ready.promise;

    // A save inside the same millisecond with the same length: the person made it, so the
    // trigger must fire even though no version moved.
    contents.set("src/a.ts", "bbbb");
    files.send({
      type: "changes",
      changes: [{ path: "src/a.ts", kind: "modified", directory: false }],
    });
    await until(() => received.length === 1);
    expect(received[0]?.variables).toMatchObject({ path: "src/a.ts", kind: "changed" });

    // The live batch refreshed the baseline, so the rescan that follows has nothing to say.
    files.send({ type: "rescan" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toHaveLength(1);
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rescan and the live batch that follows it report one change", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    const versions = new Map([["src/a.ts", { size: 4, mtime: 10 }]]);
    const contents = new Map([["src/a.ts", "aaaa"]]);
    const files = fakeCheckout(versions, contents);
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool: files.tool } },
    } as unknown as ServiceContext;
    const received: AutomationEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(context).subscribe(
      root,
      ["src/**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    await ready.promise;

    // The watcher's batch for this save is lost; the rescan reports the version it moved to.
    versions.set("src/a.ts", { size: 5, mtime: 11 });
    contents.set("src/a.ts", "bbbbb");
    files.send({ type: "rescan" });
    await until(() => received.length === 1);

    // The late batch names the version the rescan just reported: the person gets one trigger.
    files.send({
      type: "changes",
      changes: [{ path: "src/a.ts", kind: "modified", directory: false }],
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toHaveLength(1);
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an incomplete scan keeps the last complete baseline instead of inventing creates", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    // Three matching paths with room to remember two: every walk of the whole tree is too big.
    const versions = new Map([
      ["src/a.ts", { size: 1, mtime: 1 }],
      ["src/b.ts", { size: 1, mtime: 1 }],
      ["src/c.ts", { size: 1, mtime: 1 }],
    ]);
    const contents = new Map([
      ["src/a.ts", "a"],
      ["src/b.ts", "b"],
      ["src/c.ts", "c"],
    ]);
    const files = fakeCheckout(versions, contents);
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool: files.tool } },
    } as unknown as ServiceContext;
    const received: AutomationEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(context, {
      snapshotLimit: 2,
      bufferLimit: 100,
    }).subscribe(
      root,
      ["src/**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    await ready.promise;

    // The seed could not read everything, so the first complete scan has no baseline to compare
    // with. Reporting creates for the files that were there all along is the bug this guards.
    files.send({ type: "rescan" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toEqual([]);

    versions.delete("src/c.ts");
    contents.delete("src/c.ts");
    files.send({ type: "rescan" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toEqual([]);

    // The scan that seeded silently is a valid baseline: content that moved is still a change.
    contents.set("src/a.ts", "A");
    files.send({ type: "rescan" });
    await until(() => received.length === 1);
    expect(received[0]?.variables).toMatchObject({ path: "src/a.ts", kind: "changed" });

    // A later scan that cannot see everything leaves the complete baseline in place rather than
    // emptying it, so the next complete scan does not read the tree as all new.
    versions.set("src/d.ts", { size: 1, mtime: 1 });
    contents.set("src/d.ts", "d");
    files.send({ type: "rescan" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toHaveLength(1);
    versions.delete("src/d.ts");
    contents.delete("src/d.ts");
    files.send({ type: "rescan" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toHaveLength(1);
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live save that reuses the version a rescan reported is still a change", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    const versions = new Map([["src/a.ts", { size: 4, mtime: 10 }]]);
    const contents = new Map([["src/a.ts", "aaaa"]]);
    const files = fakeCheckout(versions, contents);
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool: files.tool } },
    } as unknown as ServiceContext;
    const received: AutomationEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(context).subscribe(
      root,
      ["src/**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    await ready.promise;

    versions.set("src/a.ts", { size: 5, mtime: 11 });
    contents.set("src/a.ts", "bbbbb");
    files.send({ type: "rescan" });
    await until(() => received.length === 1);
    expect(received[0]?.variables).toMatchObject({ path: "src/a.ts", kind: "changed" });

    // Another save lands before the watcher's batch for the first one. It keeps the version the
    // rescan reported but changes the bytes again, so dedup must not swallow it.
    contents.set("src/a.ts", "ccccc");
    files.send({
      type: "changes",
      changes: [{ path: "src/a.ts", kind: "modified", directory: false }],
    });
    await until(() => received.length === 2);
    expect(received[1]?.variables).toMatchObject({ path: "src/a.ts", kind: "changed" });
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rescan of an untouched checkout reports nothing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-files-")));
  try {
    let listener: ((payload: EventPayload) => void) | undefined;
    const tool = {
      watch: async (_path: string, onBatch: (payload: EventPayload) => void) => {
        listener = onBatch;
        return async () => {};
      },
      listFolder: async () => ({
        entries: [
          {
            name: "keep.ts",
            path: "src/keep.ts",
            kind: "file" as const,
            size: 4,
            mtimeMs: 7,
            ignored: false,
          },
        ],
        nextCursor: null,
        total: 1,
      }),
      run: async <T>(
        _path: string,
        task: (client: {
          fingerprint: (
            root: number,
            path: string,
          ) => Promise<{ version: string; size: number; digest: string }>;
        }) => Promise<T>,
      ): Promise<T> =>
        task({
          fingerprint: async (_root, path) => ({
            version: "4:7",
            size: 4,
            digest: path,
          }),
        }),
    };
    const context = {
      id: () => "trigger",
      log: { log: () => {} },
      resources: { own: () => {} },
      store: { atomic: () => ({ path: root }) },
      services: { filesNative: { tool } },
    } as unknown as ServiceContext;
    const received: AutomationEvent[] = [];
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(context).subscribe(
      root,
      ["src/**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    await ready.promise;
    listener?.({ type: "rescan" });
    // Let the rescan finish; it seeds nothing new and has nothing to report.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received).toEqual([]);
    dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
