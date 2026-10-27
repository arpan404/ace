import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type { WorkspaceId } from "@ace/protocol";
import { git, registered, transferMachines } from "./transfer-test-support.ts";

type Machines = Awaited<ReturnType<typeof transferMachines>>;

async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** Every file under `root`, folder-relative, sorted. */
async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  // Expected lists name files the way the archive does, with `/` on Windows too.
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .map((path) => (process.platform === "win32" ? path.replaceAll("\\", "/") : path))
    .toSorted();
}

async function send(
  m: Machines,
  workspaceId: WorkspaceId,
  options: { includeIgnored: boolean; includeChanges?: boolean },
) {
  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: options.includeChanges ?? true,
    includeIgnored: options.includeIgnored,
  });
  expect(receipt.ok).toBe(true);
  const started = m.source.daemon.transfers.outgoing
    .list()
    .find((entry) => entry.commandId === receipt.commandId);
  return m.settled(started?.transferId);
}

/** A monorepo with two packages; `web` has dependencies, a build and a local `.env`. */
async function monorepo(root: string) {
  const path = join(root, "mono");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await put(join(path, ".gitignore"), "node_modules/\n.env\ndist/\n");
  await put(join(path, "packages", "web", "index.ts"), "export {};\n");
  await put(join(path, "packages", "api", "server.ts"), "export {};\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "first");
  const web = join(path, "packages", "web");
  await put(join(web, "draft.ts"), "uncommitted\n");
  await put(join(web, "node_modules", "react", "index.js"), "module.exports = 1;\n");
  await put(join(web, "dist", "app.js"), "built\n");
  await put(join(web, ".env"), "TOKEN=1\n");
  return { path, web };
}

it("sends only the project's folder when the project is a folder inside a repository", async () => {
  const m = await transferMachines();
  const { web } = await monorepo(m.sourceRoot);
  const workspaceId = await m.addProject(m.source, web);

  const transfer = await send(m, workspaceId, { includeIgnored: false });
  expect(transfer).toMatchObject({ phase: "completed", method: "archive" });
  const there = transfer.result?.path ?? "";
  expect(dirname(there)).toBe(m.targetRoot);
  // Only web's own files, uncommitted ones included; nothing Git ignores, no repository.
  expect(await files(there)).toEqual(["draft.ts", "index.ts"]);
});

it("brings a subfolder's ignored files when allowed, still without its dependency folders", async () => {
  const m = await transferMachines();
  const { web } = await monorepo(m.sourceRoot);
  const workspaceId = await m.addProject(m.source, web);

  const transfer = await send(m, workspaceId, { includeIgnored: true });
  expect(transfer).toMatchObject({ phase: "completed", method: "archive" });
  const there = transfer.result?.path ?? "";
  expect(await files(there)).toEqual([".env", "dist/app.js", "draft.ts", "index.ts"]);
});

it("leaves dependency folders of a plain folder behind, and its .env unless ignored files may go", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "scripts");
  await put(join(path, "main.py"), "print(1)\n");
  await put(join(path, ".env"), "TOKEN=1\n");
  await put(join(path, ".env.example"), "TOKEN=\n");
  await put(join(path, ".venv", "bin", "python"), "binary\n");
  await put(join(path, "web", "node_modules", "react", "index.js"), "module.exports = 1;\n");
  await put(join(path, "web", "app.js"), "app\n");
  await put(join(path, "rust", "target", "debug", "app"), "binary\n");
  const workspaceId = await m.addProject(m.source, path);

  const without = await send(m, workspaceId, { includeIgnored: false });
  expect(without).toMatchObject({ phase: "completed", method: "archive" });
  expect(await files(without.result?.path ?? "")).toEqual([
    ".env.example",
    "main.py",
    "web/app.js",
  ]);

  const withIgnored = await send(m, workspaceId, { includeIgnored: true });
  expect(withIgnored).toMatchObject({ phase: "completed", method: "archive" });
  expect(await files(withIgnored.result?.path ?? "")).toEqual([
    ".env",
    ".env.example",
    "main.py",
    "web/app.js",
  ]);
});

it("sends a repository with no commits and nothing to carry as a copy of its files", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "fresh");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await put(join(path, "notes.md"), "start\n");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await send(m, workspaceId, { includeIgnored: false, includeChanges: false });
  expect(transfer).toMatchObject({ phase: "completed", method: "archive" });
  const there = transfer.result?.path ?? "";
  expect(await files(there)).toEqual(["notes.md"]);
  expect(await readFile(join(there, "notes.md"), "utf8")).toBe("start\n");
});

it("fails in words, copying nothing, when Git can't read the project's repository", async () => {
  const m = await transferMachines();
  const path = join(m.sourceRoot, "broken");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await put(join(path, "a.txt"), "a\n");
  const workspaceId = await m.addProject(m.source, path);
  await writeFile(join(path, ".git", "config"), "[core\nthis is not config\n");

  const transfer = await send(m, workspaceId, { includeIgnored: false });
  expect(transfer).toMatchObject({ phase: "failed", error: { code: "source_unreadable" } });
  expect(transfer.error?.message).toContain("git status");
  expect(registered(m.target).filter((entry) => entry.startsWith(m.targetRoot))).toEqual([]);
  expect(await readdir(m.targetRoot)).toEqual([]);
});

it("lands a copy beside home instead of inside a repository the newest project there sits in", async () => {
  const m = await transferMachines();
  const there = join(m.targetRoot, "mono");
  await mkdir(join(there, "packages", "web"), { recursive: true });
  await git(there, "init", "-b", "main");
  await m.addProject(m.target, join(there, "packages", "web"));
  const path = join(m.sourceRoot, "notes");
  await put(join(path, "today.md"), "notes\n");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await send(m, workspaceId, { includeIgnored: false });
  expect(transfer).toMatchObject({ phase: "completed" });
  expect(transfer.result?.path).toBe(join(m.targetRoot, "notes"));
});
