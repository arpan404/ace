import { mkdtemp, rm, writeFile, chmod, symlink, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Store } from "./store.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { Thread, Command } from "@ace/protocol";

test("workspace reads expose declared scripts and installed editors and receipts return a native editor descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-workspace-actions-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Project");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Project thread",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    editorPath: root,
    platform: "linux",
    editorLocations: [],
  });
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { dev: "echo dev", build: "echo build" } }),
    );
    await writeFile(join(root, "Procfile"), "web: echo web\n");
    await writeFile(join(root, "Makefile"), "test:\n\techo test\n");
    await writeFile(join(root, "justfile"), "serve:\n  echo serve\n");
    const scripts = await runtime.read({
      type: "workspace.request",
      requestId: "scripts",
      operation: { op: "scripts.list", threadId: thread.id },
    });
    expect(scripts.result).toMatchObject({
      kind: "scripts",
      scripts: expect.arrayContaining([
        { id: "package.json:dev", name: "dev", source: "package.json", command: "npm run 'dev'" },
        { id: "Procfile:web", name: "web", source: "Procfile", command: "echo web" },
        { id: "Makefile:test", name: "test", source: "Makefile", command: "make 'test'" },
        { id: "justfile:serve", name: "serve", source: "justfile", command: "just 'serve'" },
      ]),
    });
    // Names alone are not installation evidence: directories, non-executable files and broken links do not qualify.
    await mkdir(join(root, "zed"));
    await writeFile(join(root, "cursor"), "not an executable");
    await chmod(join(root, "cursor"), 0o600);
    await symlink(join(root, "missing-idea"), join(root, "idea"));
    expect(
      (
        await runtime.read({
          type: "workspace.request",
          requestId: "empty-editors",
          operation: { op: "editors.list" },
        })
      ).result,
    ).toEqual({ kind: "editors", editors: [] });
    await writeFile(join(root, "code"), "#!/bin/sh\nexit 0\n");
    await chmod(join(root, "code"), 0o700);
    expect(
      (
        await runtime.read({
          type: "workspace.request",
          requestId: "editors",
          operation: { op: "editors.list" },
        })
      ).result,
    ).toMatchObject({ kind: "editors", editors: [{ id: "code", command: join(root, "code") }] });
    const command = Command.parse({
      id: "open",
      deviceId: "desktop",
      payload: { type: "workspace.editor.open", threadId: thread.id, editorId: "code" },
    });
    expect(await runtime.execute(command)).toMatchObject({
      ok: true,
      editor: { editor: { id: "code" }, path: root },
    });
    expect(await runtime.execute(command)).toMatchObject({ ok: true, editor: { path: root } });
    await rm(join(root, "code"));
    expect(
      (
        await runtime.read({
          type: "workspace.request",
          requestId: "removed-editors",
          operation: { op: "editors.list" },
        })
      ).result,
    ).toEqual({ kind: "editors", editors: [] });
    expect(
      await runtime.execute(Command.parse({ ...command, id: "removed-editor" })),
    ).toMatchObject({ ok: false });

    expect(
      await runtime.execute(
        Command.parse({
          ...command,
          id: "missing",
          payload: {
            type: "workspace.script.run",
            threadId: thread.id,
            scriptId: "arbitrary:curl",
          },
        }),
      ),
    ).toMatchObject({ ok: false });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("script discovery refuses a manifest symlink instead of reading outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-scripts-boundary-"));
  try {
    await writeFile(
      join(root, "outside.json"),
      JSON.stringify({ scripts: { stolen: "echo outside" } }),
    );
    await symlink(join(root, "outside.json"), join(root, "package.json"));
    await writeFile(join(root, "Procfile"), "web: echo web\n");
    await expect(listScripts(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
import { listScripts } from "./workspace-scripts.ts";

test("running a declared script returns an owned terminal with actual process output and exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-script-run-"));
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(root, "Scripts");
  const thread = Thread.parse({
    id: "thread",
    workspaceId,
    provider: "codex",
    title: "Script",
    status: { state: "new" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000);
  try {
    await writeFile(
      join(root, "Procfile"),
      "verify: printf 'script reached process\\n' > reached.txt; cat reached.txt\n",
    );
    const result = await runtime.execute(
      Command.parse({
        id: "run",
        deviceId: "desktop",
        payload: { type: "workspace.script.run", threadId: thread.id, scriptId: "Procfile:verify" },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.terminalId) throw new Error("Expected terminal receipt");
    const attachment = runtime.terminal(result.terminalId, thread.id).attach({ fromOffset: 0 });
    let output = "",
      exited = false;
    try {
      for await (const event of attachment) {
        if (event.type === "data") output += event.data;
        if (event.type === "exit") {
          expect(event.status.code).toBe(0);
          exited = true;
          break;
        }
        if (event.type === "resync") throw new Error("Unexpected fixture overflow");
      }
    } finally {
      attachment.detach();
    }
    expect(output).toContain("script reached process");
    expect(await readFile(join(root, "reached.txt"), "utf8")).toBe("script reached process\n");
    expect(exited).toBe(true);
    expect(
      await runtime.execute(
        Command.parse({
          id: "run",
          deviceId: "desktop",
          payload: {
            type: "workspace.script.run",
            threadId: thread.id,
            scriptId: "Procfile:verify",
          },
        }),
      ),
    ).toMatchObject({ terminalId: result.terminalId });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("editor discovery finds a macOS app without a PATH launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-editor-bundle-"));
  const launcher = join(root, "Visual Studio Code.app/Contents/Resources/app/bin/code");
  await mkdir(join(root, "Visual Studio Code.app/Contents/Resources/app/bin"), { recursive: true });
  await writeFile(launcher, "#!/bin/sh\nexit 0\n");
  await chmod(launcher, 0o700);
  const store = new Store(join(root, "events.sqlite"));
  const runtime = new WorkspaceRuntime(store, root, () => 1000, {
    editorPath: "",
    platform: "darwin",
    editorLocations: [root],
  });
  try {
    expect(
      (
        await runtime.read({
          type: "workspace.request",
          requestId: "editors",
          operation: { op: "editors.list" },
        })
      ).result,
    ).toMatchObject({ kind: "editors", editors: [{ id: "code", command: launcher }] });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("working-tree diff includes shell edits and untracked files without changing the git index", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "ace-changes-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git("git", ["init", "-q", repo]);
  await writeFile(join(repo, "README.md"), "Initial\n");
  await git("git", ["-C", repo, "add", "README.md"]);
  await git("git", [
    "-C",
    repo,
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@example.test",
    "commit",
    "-qm",
    "initial",
  ]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(repo, "QA");
  const thread = Thread.parse({
    id: "changes",
    workspaceId,
    provider: "codex",
    title: "Shell edit",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000);
  try {
    await writeFile(join(repo, "README.md"), "Initial\nQA shell edit\n");
    await writeFile(join(repo, "new.txt"), "QA new file\n");
    const reply = await runtime.read({
      type: "workspace.request",
      requestId: "diff",
      operation: { op: "git.diff", threadId: thread.id },
    });
    expect(reply.result).toMatchObject({
      kind: "gitDiff",
      truncated: false,
      patch: expect.stringContaining("+QA shell edit"),
    });
    expect(reply.result).toMatchObject({ patch: expect.stringContaining("+QA new file") });
    expect((await git("git", ["-C", repo, "diff", "--cached", "--name-only"])).stdout).toBe("");
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one file's diff past the whole-checkout cap reads alone, page by page, to its last line", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "ace-diff-pages-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git("git", ["init", "-q", repo]);
  await writeFile(join(repo, "small.txt"), "one\n");
  await git("git", ["-C", repo, "add", "small.txt"]);
  await git("git", [
    "-C",
    repo,
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@example.test",
    "commit",
    "-qm",
    "initial",
  ]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(repo, "QA");
  const thread = Thread.parse({
    id: "pages",
    workspaceId,
    provider: "codex",
    title: "Big file",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  const runtime = new WorkspaceRuntime(store, root, () => 1000);
  const read = async (operation: Record<string, unknown>) =>
    (
      await runtime.read({
        type: "workspace.request",
        requestId: "diff",
        operation: { op: "git.diff", threadId: thread.id, ...operation },
      } as Parameters<WorkspaceRuntime["read"]>[0])
    ).result;
  try {
    const lines = Array.from({ length: 20_000 }, (_, i) => `generated line ${i + 1} ✓`);
    await writeFile(join(repo, "big.txt"), `${lines.join("\n")}\n`);
    await writeFile(join(repo, "small.txt"), "one\ntwo\n");
    // The whole checkout no longer fits one reply.
    expect(await read({})).toMatchObject({ kind: "gitDiff", truncated: true });

    let patch = "";
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const page = await read({ path: "big.txt", offset });
      if (page.kind !== "gitDiff") throw new Error(`unexpected ${page.kind}`);
      // Every page but the last ends on a whole line.
      if (page.nextOffset !== undefined) expect(page.patch.endsWith("\n")).toBe(true);
      expect(page.truncated).toBe(page.nextOffset !== undefined);
      patch += page.patch;
      offset = page.nextOffset;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(patch).not.toContain("small.txt");
    const added = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
    expect(added.map((line) => line.slice(1))).toEqual(lines);
    // A small file read alone fits one page.
    expect(await read({ path: "small.txt" })).toMatchObject({
      kind: "gitDiff",
      truncated: false,
      patch: expect.stringContaining("+two"),
    });
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a file edited while its pages are read is refused at its old version, never stitched from two diffs", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const git = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "ace-diff-version-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  await git("git", ["init", "-q", repo]);
  await writeFile(join(repo, "big.txt"), "seed\n");
  await git("git", ["-C", repo, "add", "big.txt"]);
  await git("git", [
    "-C",
    repo,
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@example.test",
    "commit",
    "-qm",
    "initial",
  ]);
  const store = new Store(join(root, "events.sqlite"));
  const workspaceId = store.createWorkspace(repo, "QA");
  const thread = Thread.parse({
    id: "versions",
    workspaceId,
    provider: "codex",
    title: "Edited mid-read",
    status: { state: "done" },
    createdAt: 1,
    updatedAt: 1,
  });
  store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
  let now = 1000;
  const runtime = new WorkspaceRuntime(store, root, () => now);
  const read = async (operation: Record<string, unknown>) => {
    const reply = await runtime.read({
      type: "workspace.request",
      requestId: "diff",
      operation: { op: "git.diff", threadId: thread.id, path: "big.txt", ...operation },
    } as Parameters<WorkspaceRuntime["read"]>[0]);
    if (reply.result.kind !== "gitDiff") throw new Error(`unexpected ${reply.result.kind}`);
    return reply.result;
  };
  const added = (patch: string) =>
    patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
  try {
    const before = Array.from({ length: 30_000 }, (_, i) => `before ${i + 1}`);
    await writeFile(join(repo, "big.txt"), `${before.join("\n")}\n`);
    const first = await read({ offset: 0 });
    expect(first.validator).toEqual(expect.any(String));
    expect(first.nextOffset).toBeDefined();

    // The file changes after its first page; the rest still reads the version page 0 named.
    const after = Array.from({ length: 30_000 }, (_, i) => `after ${i + 1}`);
    await writeFile(join(repo, "big.txt"), `${after.join("\n")}\n`);
    let patch = first.patch;
    let offset = first.nextOffset;
    const second = await read({ offset, expected: first.validator });
    expect(second.validator).toBe(first.validator);
    patch += second.patch;
    offset = second.nextOffset;

    // Once that version is gone from the daemon, a page asked for at it is refused.
    now += 10 * 60_000;
    await expect(read({ offset, expected: first.validator })).rejects.toThrow("diff_changed");

    // A first page names the new version, and its pages stitch to the new file only.
    const fresh = await read({ offset: 0 });
    expect(fresh.validator).not.toBe(first.validator);
    let rest = fresh.patch;
    for (let next = fresh.nextOffset; next !== undefined; ) {
      const page = await read({ offset: next, expected: fresh.validator });
      rest += page.patch;
      next = page.nextOffset;
    }
    expect(added(rest)).toEqual(after);
    expect(added(patch).every((line) => line.startsWith("before "))).toBe(true);
  } finally {
    await runtime.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
