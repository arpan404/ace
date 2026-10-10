import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { GitService } from "@ace/git";
import { createPreviewGateway } from "@ace/preview";
import { Store } from "./store.ts";
import { createDevThread } from "./commands.ts";
import { readConfig } from "./config.ts";
import { WorkspaceCreations } from "./creation-workspace.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { FilesWorkspaces } from "./files-workspaces.ts";
import { PreviewClient } from "./preview-client.ts";
import { git, repository } from "./thread-creation-test-support.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "ace-reliability-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const project = join(home, "project");
  await mkdir(project);
  const store = new Store(join(home, "events.sqlite"));
  cleanup.push(async () => store.close());
  const workspace = store.createWorkspace(project, "Fixture");
  return { home, project, store, workspace };
}
async function creationFixture() {
  const f = await fixture();
  await repository(f.project);
  await writeFile(
    join(f.project, "Procfile"),
    "setup: mkdir -p ignored && printf dependency > ignored/file\n",
  );
  await writeFile(join(f.project, ".gitignore"), "ignored/\n");
  await git("git", ["-C", f.project, "add", "."]);
  await git("git", [
    "-C",
    f.project,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "Setup",
  ]);
  const service = new GitService();
  cleanup.push(() => service.close());
  const creations = new WorkspaceCreations(f.store, service, f.home, 15_000);
  const draft = (id: string) =>
    Command.parse({
      id: `create-${id}`,
      deviceId: "device",
      payload: {
        type: "thread.create",
        threadId: id,
        workspaceId: f.workspace,
        provider: "codex",
        mode: "worktree",
        base: { ref: "main" },
        input: [{ type: "text", text: "fixture" }],
      },
    });
  return { ...f, service, creations, draft };
}

test("releasing a prepared workspace removes setup dependencies and leaves capacity for another creation", async () => {
  const f = await creationFixture();
  const lease = await f.creations.prepare(f.draft("first"));
  if (!lease) throw new Error("Missing lease");
  expect(await readFile(join(lease.workspace.path, "ignored", "file"), "utf8")).toBe("dependency");
  await lease.release();
  await expect(access(lease.workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  const next = await f.creations.prepare(f.draft("next"));
  if (!next) throw new Error("Missing second lease");
  await next.release();
  await f.creations.close();
});

test("restart recovery removes setup files and an unrelated cleanup failure does not block new worktrees", async () => {
  const f = await creationFixture();
  const abandoned = await f.creations.prepare(f.draft("abandoned"));
  if (!abandoned) throw new Error("Missing lease");
  const restarted = new WorkspaceCreations(f.store, f.service, f.home, 15_000);
  await restarted.ready();
  await expect(access(abandoned.workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  const changed = await restarted.prepare(f.draft("changed"));
  if (!changed) throw new Error("Missing lease");
  await writeFile(join(changed.workspace.path, "external"), "keep");
  await git("git", ["-C", changed.workspace.path, "add", "external"]);
  await git("git", [
    "-C",
    changed.workspace.path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@ace.local",
    "commit",
    "-m",
    "External owner change",
  ]);
  await expect(changed.release()).rejects.toThrow("identity changed");
  const recovered = new WorkspaceCreations(f.store, f.service, f.home, 15_000);
  await recovered.ready();
  await expect(recovered.ready(ThreadId.parse("changed"))).rejects.toThrow(
    "workspace_cleanup_required",
  );
  const next = await recovered.prepare(f.draft("independent"));
  if (!next) throw new Error("Missing lease");
  await next.release();
  expect(await readFile(join(changed.workspace.path, "external"), "utf8")).toBe("keep");
});

test("idle file owners are evicted after 64 roots and a leased root remains usable", async () => {
  const f = await fixture();
  const roots = new FilesWorkspaces({
    store: f.store,
    config: readConfig({ ACE_HOME: f.home }, f.home),
    options: {},
    now: () => 1000,
    id: randomUUID,
  });
  cleanup.push(() => roots.close());
  const retained = createDevThread(f.store, f.workspace);
  const { service: retainedFiles, release } = await roots.acquire(retained.id);
  cleanup.push(async () => release());
  let firstFiles: Awaited<ReturnType<typeof roots.get>> | undefined;
  for (let n = 0; n < 65; n++) {
    const root = join(f.home, `root-${n}`);
    await mkdir(root);
    const workspace = f.store.createWorkspace(root, `Workspace ${n}`);
    const thread = createDevThread(f.store, workspace);
    const files = await roots.get(thread.id);
    if (n === 0) firstFiles = files;
    await files.request("writer", {
      op: "create",
      path: "file",
      expected: null,
      text: `bytes-${n}`,
    });
  }
  if (!firstFiles) throw new Error("Missing first file owner");
  await expect(firstFiles.request("writer", { op: "stat", path: "file" })).rejects.toThrow(
    "closed",
  );
  await retainedFiles.request("writer", {
    op: "create",
    path: "retained",
    expected: null,
    text: "kept",
  });
  expect(await readFile(join(f.project, "retained"), "utf8")).toBe("kept");
});

test("deleted threads release preview ownership and their ports can be forwarded by another thread", async () => {
  const available = new Set([ThreadId.parse("old"), ThreadId.parse("next")]);
  const gateway = await createPreviewGateway({
    host: "127.0.0.1",
    wildcardHost: "preview.test",
    authority: { authorize: async () => "device", isPaired: async () => true },
    now: () => 1000,
  });
  cleanup.push(() => gateway.close());
  const previews = new PreviewClient((id) => available.has(id));
  previews.bind(gateway);
  for (let n = 0; n < 64; n++) previews.register(ThreadId.parse("old"), 3000 + n, "listener");
  available.delete(ThreadId.parse("old"));
  previews.register(ThreadId.parse("next"), 3000, "listener");
  expect(previews.list(ThreadId.parse("old"))).toEqual([]);
  expect(previews.list(ThreadId.parse("next"))).toHaveLength(1);
  await expect(previews.link(ThreadId.parse("old"), 3000, "device")).rejects.toThrow(
    "preview_not_found",
  );
  await expect(previews.link(ThreadId.parse("next"), 3000, "device")).resolves.toMatchObject({
    url: expect.any(String),
  });
});

test("exited script terminals release their slots before the next terminal opens", async () => {
  const f = await fixture();
  const thread = createDevThread(f.store, f.workspace);
  const runtime = new WorkspaceRuntime(f.store, f.home, () => 1000, {
    terminal: {
      dependencies: {
        backendFactory(options) {
          const child = spawn(process.execPath, ["-e", "process.stdout.write('fixture')"], {
            cwd: options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const exit = once(child, "exit");
          const pid = child.pid;
          if (pid === undefined) throw new Error("No fixture pid");
          return {
            pid,
            write() {},
            resize() {},
            onData(listener) {
              child.stdout.on("data", listener);
              return () => child.stdout.off("data", listener);
            },
            onExit(listener) {
              const done = (code: number | null) => listener({ code: code ?? 1, signal: null });
              child.on("exit", done);
              return () => child.off("exit", done);
            },
            async kill() {
              child.kill();
              await exit;
            },
            async close() {
              await exit;
            },
          };
        },
      },
    },
  });
  cleanup.push(() => runtime.close());
  for (let n = 0; n < 65; n++) {
    const id = await runtime.openTerminal(thread.id, `script-${n}`);
    await runtime.terminal(id, thread.id).exited;
  }
  expect(runtime.liveTerminalCount(thread.id)).toBe(0);
  expect(runtime.listTerminals(thread.id)).toHaveLength(1);
});

test("project metadata expires on its short deadline independently of the clone deadline", async () => {
  const { projectFixture } = await import("./projects-test-support.ts");
  const f = await projectFixture({
    git: {
      timeoutMs: 600_000,
      processRuntime: {
        scheduleTimeout(callback, milliseconds) {
          if (milliseconds <= 10_000) queueMicrotask(callback);
          return () => {};
        },
      },
    },
  });
  cleanup.push(() => f.close());
  expect((await f.read({ op: "fs.home" })).result).toEqual({ kind: "error", code: "git_timeout" });
});
