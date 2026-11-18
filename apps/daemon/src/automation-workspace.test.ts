import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import type { AutomationEvent } from "@ace/protocol";
import type { EventPayload } from "@ace/files-native";
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
    const files = ["src/a.ts"];
    const tool = {
      watch: async (_path: string, onBatch: (payload: EventPayload) => void) => {
        listener = onBatch;
        return async () => {
          disposed++;
        };
      },
      listFolder: async () => ({
        entries: files.map((path) => ({
          name: path.split("/").at(-1) ?? path,
          path,
          kind: "file" as const,
          size: 1,
          mtimeMs: 1,
          ignored: false,
        })),
        nextCursor: null,
        total: files.length,
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

    files.push("src/b.ts");
    listener?.({ type: "rescan" });
    await until(() => received.length === 2);
    expect(received[1]?.variables).toMatchObject({ path: "src/b.ts", kind: "created" });
    dispose();
    await until(() => disposed === 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
