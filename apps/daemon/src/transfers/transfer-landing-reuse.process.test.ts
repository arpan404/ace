import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WorkspaceId } from "@ace/protocol";
import {
  git,
  registered,
  repositoryWithOrigin,
  transferMachines,
  type Machines,
} from "./transfer-test-support.ts";

/** Folders in a project root, without Git's own lease bookkeeping beside repositories. */
const folders = async (root: string) =>
  (await readdir(root)).filter((name) => !name.startsWith(".ace-git")).toSorted();

const status = (path: string) => git(path, "status", "--porcelain", "--untracked-files=all");

/** Two machines, and a way to add a project on the sending one. */
async function namedMachines() {
  const m = await transferMachines({});
  return { m, add: (path: string) => m.addProject(m.source, path) };
}

/** Sends the project and waits for that transfer to settle. */
async function send(m: Machines, workspaceId: WorkspaceId, includeChanges = true) {
  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges,
  });
  if (!receipt.ok) throw new Error(`Refused: ${receipt.error}`);
  const commandId = m.here.lastCommand();
  const transfer = await vi.waitFor(() => {
    const found = m.source.daemon.transfers.outgoing
      .list()
      .find((entry) => entry.commandId === commandId);
    if (!found) throw new Error("Not started yet");
    return found;
  });
  return m.settled(transfer.transferId);
}

/** The target's own clone of the same origin, registered there as a project. */
async function cloneThere(m: Machines, origin: string) {
  const path = join(m.targetRoot, "app-there");
  await git(m.targetRoot, "clone", `file://${origin}`, path);
  return { path, workspaceId: await m.addProject(m.target, path) };
}

it("a folder sent again lands in its earlier copy, adding only files it lacks and keeping its own", async () => {
  const { m, add } = await namedMachines();
  const path = join(m.sourceRoot, "notes");
  await mkdir(path);
  await writeFile(join(path, "today.md"), "first draft\n");
  const workspaceId = await add(path);
  const first = await send(m, workspaceId);
  expect(first).toMatchObject({ phase: "completed", method: "archive" });
  const there = first.result?.path ?? "";
  // There, the person edits the copy; here, the same file changes and a new one appears.
  await writeFile(join(there, "today.md"), "their edit\n");
  await writeFile(join(path, "today.md"), "second draft\n");
  await writeFile(join(path, "tomorrow.md"), "plans\n");
  const before = registered(m.target);

  const again = await send(m, workspaceId);
  expect(again).toMatchObject({
    phase: "completed",
    method: "archive",
    result: { workspaceId: first.result?.workspaceId, path: there, keptFiles: 1 },
  });
  expect(await readFile(join(there, "today.md"), "utf8")).toBe("their edit\n");
  expect(await readFile(join(there, "tomorrow.md"), "utf8")).toBe("plans\n");
  expect(await folders(m.targetRoot)).toEqual(["notes"]);
  expect(registered(m.target)).toEqual(before);
});

it("a repository without a remote sent again lands its new commits in the same project there", async () => {
  const { m, add } = await namedMachines();
  const path = join(m.sourceRoot, "local");
  await mkdir(path);
  await git(path, "init", "-b", "main");
  await writeFile(join(path, "a.txt"), "a\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "one");
  const workspaceId = await add(path);
  const first = await send(m, workspaceId);
  expect(first).toMatchObject({ phase: "completed", method: "bundle" });
  const there = first.result?.path ?? "";
  await writeFile(join(path, "b.txt"), "b\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "two");

  const again = await send(m, workspaceId);
  expect(again).toMatchObject({
    phase: "completed",
    method: "bundle",
    result: { workspaceId: first.result?.workspaceId, path: there, branch: "main" },
  });
  expect(again.result?.branchOnly).toBeUndefined();
  expect(await git(there, "log", "--format=%s")).toBe("two\none");
  expect(await status(there)).toBe("");
  expect(await folders(m.targetRoot)).toEqual(["local"]);
});

it("a clone there that fell behind origin catches up and is reused, never copied beside", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await cloneThere(m, origin);
  // Origin moves on after the clone there was made; then a commit origin doesn't have yet.
  await writeFile(join(path, "pushed.txt"), "pushed\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "pushed");
  await git(path, "push", "origin", "main");
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await send(m, workspaceId, false);
  expect(transfer).toMatchObject({
    phase: "completed",
    method: "remote",
    result: { workspaceId: there.workspaceId, path: there.path, branch: "main" },
  });
  expect(await git(there.path, "log", "--format=%s")).toBe("local\npushed\nfirst");
  expect(await folders(m.targetRoot)).toEqual(["app-there"]);
});

it("a clone there that fell behind lands a branch origin already has, with nothing else to send", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await cloneThere(m, origin);
  await writeFile(join(path, "pushed.txt"), "pushed\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "pushed");
  await git(path, "push", "origin", "main");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await send(m, workspaceId, false);
  expect(transfer).toMatchObject({
    phase: "completed",
    method: "remote",
    result: { workspaceId: there.workspaceId, path: there.path, branch: "main" },
  });
  expect(await git(there.path, "log", "-1", "--format=%s")).toBe("pushed");
  expect(await folders(m.targetRoot)).toEqual(["app-there"]);
});

it("a branch that moved on there gets the transfer on a branch of its own instead of failing", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await cloneThere(m, origin);
  await writeFile(join(there.path, "theirs.txt"), "theirs\n");
  await git(there.path, "add", "-A");
  await git(there.path, "commit", "-m", "theirs");
  const theirs = await git(there.path, "rev-parse", "main");
  await writeFile(join(path, "mine.txt"), "mine\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "mine");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await send(m, workspaceId, false);
  expect(transfer).toMatchObject({
    phase: "completed",
    result: {
      workspaceId: there.workspaceId,
      path: there.path,
      branch: "main-from-macbook",
      branchOnly: true,
    },
  });
  expect(await git(there.path, "rev-parse", "main")).toBe(theirs);
  expect(await git(there.path, "branch", "--show-current")).toBe("main");
  expect(await git(there.path, "log", "-1", "--format=%s", "main-from-macbook")).toBe("mine");
  expect(await folders(m.targetRoot)).toEqual(["app-there"]);
});

it("a checkout an agent is working in there is left alone, and the work lands on a branch of its own", async () => {
  const m = await transferMachines();
  const { path, origin } = await repositoryWithOrigin(m.sourceRoot, "app");
  const there = await cloneThere(m, origin);
  // A thread there is still working in the project's own checkout.
  const started = m.target.controls.delegations.command("busy-there", {
    type: "thread.create",
    workspaceId: there.workspaceId,
    provider: "claude",
    access: "full-access",
    input: [{ type: "text", text: "keep working" }],
  });
  if (!started.threadId) throw new Error(`Not started: ${started.error}`);
  const busy = started.threadId;
  await m.target.daemon.engine?.flush();
  await vi.waitFor(() => {
    const state = m.target.daemon.store.getThread(busy)?.status.state;
    if (state === "done" || state === "new" || state === undefined)
      throw new Error("Not working yet");
  });
  const head = await git(there.path, "rev-parse", "HEAD");
  await writeFile(join(path, "next.txt"), "next\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "next");
  await writeFile(join(path, "README.md"), "edited\n");
  const workspaceId = await m.addProject(m.source, path);

  const transfer = await send(m, workspaceId);
  expect(transfer).toMatchObject({
    phase: "completed",
    result: {
      workspaceId: there.workspaceId,
      path: there.path,
      branch: "main-from-macbook",
      branchOnly: true,
    },
  });
  // The checkout the agent works in hasn't moved or changed.
  expect(await git(there.path, "rev-parse", "HEAD")).toBe(head);
  expect(await status(there.path)).toBe("");
  // The branch carries the commit and, on top, the uncommitted edit.
  const branch = "main-from-macbook";
  expect(await git(there.path, "log", "-1", "--format=%s", `${branch}~1`)).toBe("next");
  expect(await git(there.path, "diff", "--name-only", `${branch}~1`, branch)).toBe("README.md");
});
