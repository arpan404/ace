import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnGitProcess, type GitProcessRuntime } from "@ace/git";
import type { WorkspaceActionRequest, WorkspaceId } from "@ace/protocol";
import { expect, onTestFinished, test } from "vitest";
import { Projects } from "./projects.ts";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";

const execute = promisify(execFile);

/** A daemon home with real Git checkouts, counting every Git process it starts. */
async function home() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-identity-git-")));
  const file = join(root, "events.sqlite");
  let spawned = 0;
  const processRuntime: Partial<GitProcessRuntime> = {
    spawn: (command, args, input) => {
      spawned++;
      return spawnGitProcess(command, args, input);
    },
  };
  let clock = 1000;
  const now = () => clock++;
  let store = new Store(file, undefined, { now });
  let runtime = new WorkspaceRuntime(store, join(root, "data"), now, { git: { processRuntime } });
  onTestFinished(async () => {
    await runtime.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    get spawned() {
      return spawned;
    },
    async repo(name: string, remotes: Record<string, string> = {}) {
      const path = join(root, name);
      await mkdir(path, { recursive: true });
      await execute("git", ["init", "-q", "-b", "main", path]);
      for (const [remote, url] of Object.entries(remotes))
        await execute("git", ["-C", path, "remote", "add", remote, url]);
      return path;
    },
    register(path: string): WorkspaceId {
      return store.createWorkspace(path, path.split("/").at(-1) ?? "project");
    },
    /** Work started in the project now. */
    used(id: WorkspaceId) {
      store
        .statement(
          "INSERT INTO workspace_recent VALUES (?,?) ON CONFLICT(workspace_id) DO UPDATE SET opened_at=excluded.opened_at",
        )
        .run(id, now());
    },
    ask: async (operation: WorkspaceActionRequest["operation"]) =>
      (await runtime.read({ type: "workspace.request", requestId: "ask", operation })).result,
    /** Close and open the daemon's store, projects and workspace runtime again. */
    async reopen() {
      await runtime.close();
      store.close();
      store = new Store(file, undefined, { now });
      runtime = new WorkspaceRuntime(store, join(root, "data"), now, { git: { processRuntime } });
      const projects = new Projects(store, now, {
        home: root,
        roots: async () => [root],
        git: { processRuntime },
      });
      onTestFinished(() => projects.close());
      await projects.ready;
      return projects;
    },
  };
}

test("a checkout reports every remote and its folder inside the repository; a plain folder none", async () => {
  const h = await home();
  const repo = await h.repo("app", {
    origin: "git@github.com:me/app.git",
    upstream: "https://github.com/acme/app",
  });
  await mkdir(join(repo, "packages", "api"), { recursive: true });
  const api = h.register(join(repo, "packages", "api"));
  const plain = join(h.root, "notes");
  await mkdir(plain);
  expect(await h.ask({ op: "workspace.checkout", workspaceId: api })).toEqual({
    kind: "checkout",
    checkout: {
      repository: true,
      remotes: ["github.com/acme/app", "github.com/me/app"],
      subpath: "packages/api",
    },
  });
  expect(await h.ask({ op: "workspace.checkout", workspaceId: h.register(plain) })).toEqual({
    kind: "checkout",
    checkout: { repository: false, remotes: [], subpath: "" },
  });
});

test("New thread's match picks the checkout at the same folder, then the one used last", async () => {
  const h = await home();
  const url = "https://github.com/acme/mono.git";
  const first = await h.repo("mono", { origin: url });
  const second = await h.repo("mono-2", { origin: url });
  await mkdir(join(first, "web"));
  const root = h.register(first);
  const web = h.register(join(first, "web"));
  const other = h.register(second);
  expect(await h.ask({ op: "workspaces.match", url, subpath: "web" })).toEqual({
    kind: "match",
    workspaceId: web,
  });
  // Two checkouts of the repository's top: the one used last, not the oldest.
  h.used(root);
  h.used(other);
  expect(await h.ask({ op: "workspaces.match", url })).toEqual({
    kind: "match",
    workspaceId: other,
  });
  h.used(root);
  expect(await h.ask({ op: "workspaces.match", url })).toEqual({
    kind: "match",
    workspaceId: root,
  });
});

test("suggestions come a bounded page at a time, and the cursor reads the rest", async () => {
  const h = await home();
  const shared = "https://github.com/acme/app.git";
  const ids: WorkspaceId[] = [];
  for (const name of ["a", "b", "c", "d", "e"])
    ids.push(
      h.register(
        await h.repo(name, { origin: name === "c" ? "https://github.com/acme/c" : shared }),
      ),
    );
  const found: string[] = [];
  let after: WorkspaceId | undefined;
  let pages = 0;
  do {
    const result = await h.ask({
      op: "workspaces.identitySuggestions",
      remotes: ["github.com/acme/app"],
      subpath: "",
      limit: 2,
      ...(after ? { after } : {}),
    });
    if (result.kind !== "identitySuggestions") throw new Error(result.kind);
    expect(result.suggestions.length).toBeLessThanOrEqual(2);
    found.push(...result.suggestions.map((each) => each.workspaceId));
    after = result.next ?? undefined;
    pages++;
  } while (after);
  expect(pages).toBe(3);
  expect(found).toEqual([ids[0], ids[1], ids[3], ids[4]]);
});

test("opening an existing home reads no Git and gives no project an identity", async () => {
  const h = await home();
  const ids = [
    h.register(await h.repo("one", { origin: "https://github.com/acme/one" })),
    h.register(await h.repo("two", { origin: "https://github.com/acme/two" })),
  ];
  const before = h.spawned;
  const projects = await h.reopen();
  expect(h.spawned).toBe(before);
  for (const id of ids) expect(projects.catalog.get(id).identity).toBeUndefined();
  const listed = await h.ask({ op: "workspaces.list", limit: 100 });
  expect(listed.kind === "workspaces" && listed.workspaces.map((each) => each.id)).toEqual(ids);
});
