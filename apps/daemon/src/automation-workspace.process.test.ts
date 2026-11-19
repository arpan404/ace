// Reason: an automation file trigger's reconciliation only meets its real edge when ace-files
// actually restarts under a real watcher: what the watcher lost while the process was down can
// only be recovered by the restored watch's rescan, and a fake would script the answer.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeFilesHost, systemFilesClock } from "@ace/files-native";
import { trackingHost, type TrackingHost } from "@ace/files-native/test-support";
import type { AutomationEvent } from "@ace/protocol";
import { automationWorkspace } from "./automation-workspace.ts";
import { findFilesBinary, FilesTool } from "./files-tool/tool.ts";
import type { ServiceContext } from "./services/types.ts";

const binary = findFilesBinary();

async function until(condition: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (condition()) return;
    if (Date.now() > end) throw new Error("timed out waiting for an automation event");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const received: AutomationEvent[] = [];
const roots: string[] = [];
const closing: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closing.splice(0).toReversed()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  received.length = 0;
});

async function fixture(): Promise<{ root: string; host: TrackingHost; tool: FilesTool }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-automation-process-")));
  roots.push(root);
  await writeFile(join(root, "keep.txt"), "one\n");
  await writeFile(join(root, "same.txt"), "same\n");
  const host = trackingHost(nodeFilesHost({ ...process.env }));
  const tool = new FilesTool({ binary, clock: systemFilesClock, host });
  closing.push(() => tool.close());
  return { root, host, tool };
}

const pathsOf = (event: AutomationEvent) => (event.variables.paths ?? "").split("\n");
const forPath = (path: string) => received.filter((event) => pathsOf(event).includes(path));

function contextFor(root: string, tool: FilesTool): ServiceContext {
  return {
    id: () => "trigger",
    log: { log: () => {} },
    resources: { own: () => {} },
    store: { atomic: () => ({ path: root }) },
    services: { filesNative: { tool } },
  } as unknown as ServiceContext;
}

describe.skipIf(!binary)("automation file triggers over real ace-files", () => {
  it("reconciles a restart without inventing changes, and detects an offline edit", async () => {
    const { root, host, tool } = await fixture();
    const ready = Promise.withResolvers<void>();
    const dispose = automationWorkspace(contextFor(root, tool)).subscribe(
      root,
      ["**"],
      async (event) => {
        received.push(event);
      },
      { onReady: () => ready.resolve() },
    );
    closing.push(async () => dispose());
    await ready.promise;

    // A create the watcher sees live is reported once, and only once, when a restart's rescan
    // finds it again.
    await writeFile(join(root, "live.txt"), "live\n");
    await until(() => received.some((event) => pathsOf(event).includes("live.txt")));

    // Down goes ace-files. An edit lands while nothing is watching; only the restored watch's
    // rescan can report the version it moved to.
    host.children.at(-1)?.kill();
    await writeFile(join(root, "keep.txt"), "two\n");
    await until(() => received.some((event) => pathsOf(event).includes("keep.txt")));
    await new Promise((resolve) => setTimeout(resolve, 300));

    // A create while the next reconciliation is pending is one create, not one per page.
    host.children.at(-1)?.kill();
    await writeFile(join(root, "offline.txt"), "offline\n");
    await until(() => received.some((event) => pathsOf(event).includes("offline.txt")));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(forPath("keep.txt")).toHaveLength(1);
    expect(forPath("keep.txt")[0]?.variables).toMatchObject({ kind: "changed", count: "1" });
    expect(forPath("offline.txt")).toHaveLength(1);
    expect(forPath("offline.txt")[0]?.variables).toMatchObject({ kind: "created", count: "1" });
    expect(forPath("live.txt")).toHaveLength(1);
    expect(forPath("same.txt")).toHaveLength(0);
  }, 30_000);
});
