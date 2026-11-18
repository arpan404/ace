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
          stat: (root: number, path: string) => Promise<{
            path: string;
            kind: { type: string };
            size: number;
            mtimeMs: number;
          }>;
        }) => Promise<T>,
      ): Promise<T> =>
        task({
          stat: async (_root, path) => {
            const entry = versions.get(path);
            if (!entry) throw new FilesRequestError("NOT_FOUND", `${path} is gone`);
            return { path, kind: { type: "file" }, size: entry.size, mtimeMs: entry.mtime };
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
          { name: "keep.ts", path: "src/keep.ts", kind: "file" as const, size: 4, mtimeMs: 7, ignored: false },
        ],
        nextCursor: null,
        total: 1,
      }),
      run: async <T>(): Promise<T> => {
        throw new Error("a rescan of an untouched checkout reads no versions");
      },
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
