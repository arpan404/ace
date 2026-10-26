import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceActionRequest, WorkspaceId } from "@ace/protocol";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);

/** A daemon with real checkouts: each folder name, and its `origin` when given. */
async function daemonWith(checkouts: readonly { name: string; origin?: string }[]) {
  const home = await mkdtemp(join(tmpdir(), "ace-project-origin-"));
  const store = new Store(join(home, "events.sqlite"));
  const runtime = new WorkspaceRuntime(store, join(home, "data"), () => 1000);
  const ids = new Map<string, WorkspaceId>();
  for (const checkout of checkouts) {
    const root = join(home, checkout.name);
    await mkdir(root);
    await execute("git", ["init", "-b", "main", root]);
    if (checkout.origin)
      await execute("git", ["-C", root, "remote", "add", "origin", checkout.origin]);
    ids.set(checkout.name, store.createWorkspace(root, checkout.name));
  }
  const ask = async (operation: WorkspaceActionRequest["operation"]) =>
    (await runtime.read({ type: "workspace.request", requestId: "origin", operation })).result;
  return {
    id: (name: string) => {
      const id = ids.get(name);
      if (!id) throw new Error(`no checkout ${name}`);
      return id;
    },
    ask,
    async close() {
      await runtime.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("another machine's repository is found here by its origin, however its URL is spelled", async () => {
  const daemon = await daemonWith([
    { name: "web", origin: "https://github.com/someone-else/web.git" },
    { name: "ace-main", origin: "git@github.com:acme/ace.git" },
  ]);
  try {
    expect(
      await daemon.ask({ op: "workspaces.match", url: "https://github.com/acme/ace" }),
    ).toEqual({ kind: "match", workspaceId: daemon.id("ace-main") });
    // Same folder name, another repository: not the same project.
    expect(
      await daemon.ask({ op: "workspaces.match", url: "https://github.com/acme/web" }),
    ).toEqual({ kind: "match", workspaceId: null });
  } finally {
    await daemon.close();
  }
});

test("a project reports its origin URL, and none when the repository has no origin", async () => {
  const daemon = await daemonWith([
    { name: "relay", origin: "https://github.com/acme/relay.git" },
    { name: "scratch" },
  ]);
  try {
    expect(await daemon.ask({ op: "workspace.origin", workspaceId: daemon.id("relay") })).toEqual({
      kind: "origin",
      url: "https://github.com/acme/relay.git",
    });
    expect(await daemon.ask({ op: "workspace.origin", workspaceId: daemon.id("scratch") })).toEqual(
      { kind: "origin", url: null },
    );
  } finally {
    await daemon.close();
  }
});
