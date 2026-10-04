import { Store } from "./store.ts";
import { Projects } from "./projects.ts";
import { mkdir, readFile, symlink, writeFile, readdir, stat, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, Project, ProjectsRequest, Thread, type WorkspaceChanged } from "@ace/protocol";
import { projectFixture, projectServer, until } from "./projects-test-support.ts";

// Mutation cases and all runtime assertions need run at merge. No tests executed during development.
test("adding a folder twice through a symlink returns its canonical existing project id", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "project");
    await mkdir(path);
    await symlink(path, join(f.root, "alias"));
    const first = await f.command({ type: "workspace.add", path });
    expect(first).toMatchObject({ ok: true, workspace: { name: "project", path } });
    const second = await f.command({
      type: "workspace.add",
      path: join(f.root, "alias"),
      name: "Ignored",
    });
    expect(second.workspace).toEqual(first.workspace);
    const listed = f.projects.catalog.recent(100);
    expect(listed).toEqual([first.workspace]);
    const home = await f.read({ op: "fs.home" });
    expect(home.result).toMatchObject({ kind: "home", roots: [f.root], initialBranch: "trunk" });
    expect((await f.read({ op: "fs.recentFolders", limit: 20 })).result).toMatchObject({
      kind: "recentFolders",
      folders: [first.workspace],
    });
  } finally {
    await f.close();
  }
});

test("adding a repository subfolder suggests its root and reports branch default and remotes", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "repo");
    await mkdir(path);
    await f.git(path, ["init"]);
    await f.git(path, ["remote", "add", "origin", "https://example.com/owner/project.git"]);
    await f.git(path, [
      "remote",
      "add",
      "private",
      "https://token:secret@example.com/owner/private.git",
    ]);
    const sub = join(path, "src");
    await mkdir(sub);
    const result = await f.command({ type: "workspace.add", path: sub });
    expect(result).toMatchObject({
      ok: true,
      workspace: { path: sub },
      inspection: {
        suggestedRepoRoot: path,
        git: {
          root: path,
          branch: "trunk",
          defaultBranch: "trunk",
          remotes: [
            { name: "origin", fetchUrls: ["https://example.com/owner/project.git"] },
            { name: "private", fetchUrls: [], pushUrls: [] },
          ],
        },
      },
    });
    expect(await f.command({ type: "workspace.add", path })).toMatchObject({
      ok: true,
      workspace: { path },
    });
  } finally {
    await f.close();
  }
});

test("create makes a plain folder or initializes git using the host configured branch and template", async () => {
  const f = await projectFixture();
  try {
    expect(
      await f.command({ type: "workspace.create", parent: f.root, name: "plain" }),
    ).toMatchObject({ ok: true, inspection: { git: null } });
    expect(await readdir(join(f.root, "plain"))).toEqual([]);
    expect(
      await f.command({
        type: "workspace.create",
        parent: f.root,
        name: "git",
        git: {},
        gitignore: "node_modules/\n.env\n",
      }),
    ).toMatchObject({ ok: true, inspection: { git: { branch: "trunk" } } });
    expect(await readFile(join(f.root, "git", ".gitignore"), "utf8")).toBe("node_modules/\n.env\n");
    expect(
      await f.command({
        type: "workspace.create",
        parent: f.root,
        name: "explicit",
        git: { initialBranch: "develop" },
      }),
    ).toMatchObject({ ok: true, inspection: { git: { branch: "develop" } } });
    await writeFile(join(f.root, "plain", "keep"), "keep");
    expect(
      await f.command({ type: "workspace.create", parent: f.root, name: "plain" }),
    ).toMatchObject({ ok: false, error: "destination_not_empty" });
    expect(await readFile(join(f.root, "plain", "keep"), "utf8")).toBe("keep");
    await mkdir(join(f.root, "empty"));
    expect(
      await f.command({ type: "workspace.create", parent: f.root, name: "empty" }),
    ).toMatchObject({ ok: true });
  } finally {
    await f.close();
  }
});

test("traversal missing files and symlinks outside project roots cannot register or create projects", async () => {
  const f = await projectFixture();
  try {
    await symlink(join(f.root, ".."), join(f.root, "escape"));
    await writeFile(join(f.root, "file"), "text");
    for (const path of [
      join(f.root, "escape"),
      `${f.root}/../outside`,
      "relative",
      join(f.root, "missing"),
      join(f.root, "file"),
    ])
      expect(await f.command({ type: "workspace.add", path })).toMatchObject({ ok: false });
    expect(() =>
      Command.parse({
        id: "bad",
        deviceId: "owner",
        payload: { type: "workspace.create", parent: f.root, name: "../outside" },
      }),
    ).toThrow();
    expect(
      await f.command({
        type: "workspace.create",
        parent: join(f.root, "escape"),
        name: "outside",
      }),
    ).toMatchObject({ ok: false, error: "outside_project_roots" });
    expect(
      (
        await f.read({
          op: "fs.browse",
          path: join(f.root, "escape"),
          limit: 50,
          showHidden: false,
        })
      ).result,
    ).toMatchObject({ kind: "error", code: "outside_project_roots" });
    expect(f.projects.catalog.recent(100)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("removing a live project requires explicit archive and preserves execution status and files", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "repo");
    await mkdir(path);
    await writeFile(join(path, "keep.txt"), "keep");
    const added = await f.command({ type: "workspace.add", path });
    const project = Project.parse(added.workspace);
    const thread = Thread.parse({
      id: "thread",
      workspaceId: project.id,
      title: "Live",
      provider: "codex",
      status: { state: "working", agents: 1 },
      details: { workspace: project },
      createdAt: 1,
      updatedAt: 1,
    });
    f.store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    expect(
      await f.command({ type: "workspace.remove", workspaceId: project.id, archiveThreads: false }),
    ).toMatchObject({ ok: false, error: "workspace_threads_running" });
    const changes: WorkspaceChanged[] = [];
    const stop = f.projects.subscribe((change) => changes.push(change));
    expect(
      await f.command({ type: "workspace.rename", workspaceId: project.id, name: "Renamed" }),
    ).toMatchObject({ ok: true, workspace: { name: "Renamed" } });
    expect(f.store.getThread(thread.id)?.details?.workspace?.name).toBe("Renamed");
    expect(
      await f.command({ type: "workspace.remove", workspaceId: project.id, archiveThreads: true }),
    ).toMatchObject({ ok: true });
    expect(f.store.getThread(thread.id)).toMatchObject({
      archivedAt: 1000,
      status: { state: "working", agents: 1 },
    });
    expect(f.projects.catalog.recent(100)).toEqual([]);
    expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("keep");
    expect(changes.map((change) => change.change)).toEqual(["renamed", "removed"]);
    stop();
    expect(await f.command({ type: "workspace.add", path })).toMatchObject({
      ok: true,
      workspace: { id: project.id },
    });
  } finally {
    await f.close();
  }
});

test("a project whose folder was deleted can still be renamed and unregistered", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "missing-project");
    await mkdir(path);
    const project = Project.parse((await f.command({ type: "workspace.add", path })).workspace);
    await rmdir(path);
    expect(
      await f.command({ type: "workspace.rename", workspaceId: project.id, name: "Moved" }),
    ).toMatchObject({ ok: true, workspace: { id: project.id, name: "Moved" } });
    expect(
      await f.command({ type: "workspace.remove", workspaceId: project.id, archiveThreads: false }),
    ).toMatchObject({ ok: true });
    expect(f.projects.catalog.recent(100)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("folder browsing pages sorted directories hides dot folders and excludes escaping symlinks", async () => {
  const f = await projectFixture();
  try {
    for (const name of ["a", "b", "c", ".hidden"]) await mkdir(join(f.root, name));
    await f.git(join(f.root, "b"), ["init"]);
    await symlink(join(f.root, ".."), join(f.root, "escape"));
    const first = await f.read({ op: "fs.browse", path: f.root, limit: 2, showHidden: false });
    expect(first.result).toMatchObject({
      kind: "directories",
      entries: [
        { name: "a", git: false },
        { name: "b", git: true },
      ],
      next: "b",
    });
    const second = await f.read({
      op: "fs.browse",
      path: f.root,
      limit: 2,
      after: "b",
      showHidden: false,
    });
    expect(second.result).toMatchObject({ kind: "directories", entries: [{ name: "c" }] });
    expect(second.result).not.toHaveProperty("next");
    const hidden = await f.read({ op: "fs.browse", path: f.root, limit: 100, showHidden: true });
    expect(hidden.result).toMatchObject({
      kind: "directories",
      entries: expect.arrayContaining([
        {
          name: ".hidden",
          path: join(f.root, ".hidden"),
          git: false,
          modifiedAt: expect.any(Number),
        },
      ]),
    });
    expect(() =>
      ProjectsRequest.parse({
        type: "projects.request",
        requestId: "bounds",
        operation: { op: "fs.browse", path: f.root, limit: 101 },
      }),
    ).toThrow();
    expect((await stat(join(f.root, "a"))).isDirectory()).toBe(true);
  } finally {
    await f.close();
  }
});

test("workspace pushes reach other clients and removed projects disappear from the list", async () => {
  const f = await projectFixture();
  const server = await projectServer(f);
  try {
    const one = await server.connect();
    const two = await server.connect({ deviceId: "other" });
    const path = join(f.root, "empty");
    await mkdir(path);
    one.send({
      type: "command",
      command: Command.parse({
        id: "add",
        deviceId: "owner",
        payload: { type: "workspace.add", path },
      }),
    });
    const added = await until(two, (message) => message.type === "workspace.changed");
    expect(added).toMatchObject({
      type: "workspace.changed",
      change: "added",
      workspace: { path },
    });
    const receipt = await until(one, (message) => message.type === "commandResult");
    if (receipt.type !== "commandResult" || !receipt.workspace)
      throw new Error("Expected project receipt");
    one.send({
      type: "command",
      command: Command.parse({
        id: "remove",
        deviceId: "owner",
        payload: { type: "workspace.remove", workspaceId: receipt.workspace.id },
      }),
    });
    expect(await until(two, (message) => message.type === "workspace.changed")).toMatchObject({
      change: "removed",
    });
    expect(await until(one, (message) => message.type === "commandResult")).toMatchObject({
      ok: true,
    });
    one.send({
      type: "workspace.request",
      requestId: "list",
      operation: { op: "workspaces.list", limit: 50 },
    });
    expect(await until(one, (message) => message.type === "workspace.result")).toMatchObject({
      result: { workspaces: [] },
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("folder paging preserves literal existing names and refuses an oversized directory scan", async () => {
  const f = await projectFixture();
  try {
    const path = join(f.root, "picker");
    await mkdir(path);
    for (const name of [" spaced ", "dot."]) await mkdir(join(path, name));
    const first = await f.read({ op: "fs.browse", path, limit: 1, showHidden: false });
    expect(first.result).toMatchObject({ entries: [{ name: " spaced " }], next: " spaced " });
    expect(
      (await f.read({ op: "fs.browse", path, after: " spaced ", limit: 1, showHidden: false }))
        .result,
    ).toMatchObject({ entries: [{ name: "dot." }] });
    const large = join(f.root, "large");
    await mkdir(large);
    for (let offset = 0; offset < 10_001; offset += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, 10_001 - offset) }, (_, index) =>
          writeFile(join(large, `file-${offset + index}`), ""),
        ),
      );
    }
    expect(
      (await f.read({ op: "fs.browse", path: large, limit: 1, showHidden: false })).result,
    ).toMatchObject({ kind: "error", code: "directory_too_large" });
  } finally {
    await f.close();
  }
});

test("project receipts and unregister state survive restart and reject new threads until re-added", async () => {
  const f = await projectFixture();
  let reopened: Store | undefined;
  let projects: Projects | undefined;
  try {
    const path = join(f.root, "persisted");
    await mkdir(path);
    const receipt = await f.command({ type: "workspace.add", path }, "persistent-add");
    const project = Project.parse(receipt.workspace);
    await f.command({ type: "workspace.rename", workspaceId: project.id, name: "Persisted name" });
    await f.command({ type: "workspace.remove", workspaceId: project.id, archiveThreads: false });
    await f.projects.close();
    await f.store.close();
    reopened = new Store(join(f.root, "events.sqlite"));
    projects = new Projects(reopened, () => 2000, { home: f.root, roots: async () => [f.root] });
    expect(projects.catalog.recent(100)).toEqual([]);
    const thread = Thread.parse({
      id: "new-thread",
      workspaceId: project.id,
      title: "Denied",
      provider: "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(() => reopened?.appendEvents(thread.id, [{ type: "thread.created", thread }])).toThrow(
      "workspace_unregistered",
    );
    expect(
      await projects.execute(
        Command.parse({
          id: "persistent-add",
          deviceId: "owner",
          payload: { type: "workspace.add", path },
        }),
      ),
    ).toEqual(receipt);
    expect(projects.catalog.recent(100)).toEqual([]);
    const restored = await projects.execute(
      Command.parse({ id: "restore", deviceId: "owner", payload: { type: "workspace.add", path } }),
    );
    expect(restored).toMatchObject({
      ok: true,
      workspace: { id: project.id, name: "Persisted name" },
    });
    reopened.appendEvents(thread.id, [{ type: "thread.created", thread }]);
    expect(reopened.getThread(thread.id)?.workspaceId).toBe(project.id);
  } finally {
    await projects?.close();
    await reopened?.close();
    await f.close();
  }
});

test("a newly created Git project can immediately start an isolated worktree without a user Git identity", async () => {
  const f = await projectFixture();
  const { GitService } = await import("@ace/git");
  const git = new GitService();
  try {
    const result = await f.command({
      type: "workspace.create",
      parent: f.root,
      name: "fresh",
      git: {},
    });
    expect(result.ok).toBe(true);
    const repo = join(f.root, "fresh");
    const tree = await git.createWorktree({
      repo,
      path: join(f.root, "isolated"),
      baseRef: "HEAD",
      branch: "ace/thread",
    });
    expect(tree.branch).toBe("ace/thread");
    expect(await readdir(tree.path)).toEqual([".git"]);
    expect((await git.repositoryInfo(repo)).head).toBe(
      await git.resolveCommit({ worktree: tree.path, ref: "HEAD" }),
    );
    expect((await f.git(repo, ["ls-tree", "--name-only", "HEAD"])).stdout.trim()).toBe("");
  } finally {
    await git.close();
    await f.close();
  }
});
