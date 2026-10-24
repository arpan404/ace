import { randomBytes } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TransferTransport } from "./client.ts";
import {
  finishedThread,
  git,
  registered,
  repositoryWithOrigin,
  transferMachines,
} from "./transfer-test-support.ts";

type Machines = Awaited<ReturnType<typeof transferMachines>>;

/** Folders in a project root, without Git's own lease bookkeeping beside repositories. */
const projectFolders = async (root: string) =>
  (await readdir(root)).filter((name) => name !== ".ace-git-mutation-leases").toSorted();

/** Runs `then` with the transfer id as soon as the target answers a commit: its import is running. */
function onCommit(then: (transferId: string) => Promise<void>) {
  return (inner: TransferTransport): TransferTransport =>
    async (profile, route, options) => {
      const answer = await inner(profile, route, options);
      if (route.method === "POST" && typeof route.body === "string") {
        const call = JSON.parse(route.body) as { op?: string; transferId?: string };
        if (call.op === "commit" && call.transferId) await then(call.transferId);
      }
      return answer;
    };
}

/**
 * A repository with no origin, so the whole history travels as a bundle the target clones. A
 * large file makes the target's import take long enough to be interrupted.
 */
async function bundled(m: Machines) {
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await git(path, "remote", "remove", "origin");
  await writeFile(join(path, "large.bin"), randomBytes(48 * 1024 * 1024));
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  // Uncommitted too, for a transfer that brings changes: applying them takes a while there.
  await writeFile(join(path, "draft.bin"), randomBytes(48 * 1024 * 1024));
  return m.addProject(m.source, path);
}

it("a cancel after the target registered the project undoes it, or finds the work there", async () => {
  let machines: Machines | undefined;
  let cancelled: Promise<unknown> | undefined;
  const m = await transferMachines({
    transport: onCommit(async (transferId) => {
      const there = machines;
      if (!there) return;
      // The import is past registering the project, still applying the large changes.
      await vi.waitFor(
        () => {
          if (!registered(there.target).some((path) => path.startsWith(there.targetRoot)))
            throw new Error("Not registered yet");
        },
        { timeout: 60_000, interval: 5 },
      );
      cancelled = there.source.daemon.transfers.outgoing.cancel(transferId);
    }),
  });
  machines = m;
  const before = registered(m.target);
  const workspaceId = await bundled(m);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  await vi.waitFor(
    () => {
      if (!cancelled) throw new Error("Not committed yet");
    },
    { timeout: 120_000, interval: 20 },
  );
  await cancelled;
  const transfer = await m.settled();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (transfer.phase === "completed") {
    // The cancel came after the cutoff: the project there is the result.
    expect(registered(m.target)).toContain(transfer.result?.path);
    return;
  }
  // Whatever the import had reached, nothing of it stays, and nothing turns up afterwards.
  expect(transfer.phase).toBe("cancelled");
  expect(registered(m.target)).toEqual(before);
  expect(await projectFolders(m.targetRoot)).toEqual([]);
  expect(await readdir(join(m.target.h.home, "daemon", "transfers", "incoming"))).toEqual([]);
});

it("the target's shutdown waits for a running import, which changes nothing after it", async () => {
  let machines: Machines | undefined;
  let closed: Promise<void> | undefined;
  const m = await transferMachines({
    transport: onCommit(async () => {
      closed ??= machines?.target.daemon.transfers.incoming.close();
    }),
  });
  machines = m;
  const workspaceId = await bundled(m);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  await vi.waitFor(
    () => {
      if (!closed) throw new Error("Not committed yet");
    },
    { timeout: 60_000, interval: 20 },
  );
  await closed;
  const projects = registered(m.target);
  const folders = await projectFolders(m.targetRoot);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(registered(m.target)).toEqual(projects);
  expect(await projectFolders(m.targetRoot)).toEqual(folders);
});

it("a cancel while the target prepares the new thread's worktree leaves no thread there", async () => {
  const m = await transferMachines();
  const source = await finishedThread(m, "Fix the login bug");
  // The target has the project, with its own edit in progress: the new thread gets a worktree.
  const there = join(m.targetRoot, "app-there");
  await git(m.targetRoot, "clone", await git(source.path, "remote", "get-url", "origin"), there);
  await m.addProject(m.target, there);
  await writeFile(join(there, "README.md"), "their edit\n");
  const runtime = m.target.daemon.workspaceActions;
  if (!runtime) throw new Error("No workspace runtime there");
  const prepare = runtime.prepareAgentCreation.bind(runtime);
  let cancelled: Promise<unknown> | undefined;
  // The person cancels while that worktree is being made.
  vi.spyOn(runtime, "prepareAgentCreation").mockImplementation(async (command, signal) => {
    const [running] = m.source.daemon.transfers.outgoing.list();
    if (running) cancelled = m.source.daemon.transfers.outgoing.cancel(running.transferId);
    await vi.waitFor(
      () => {
        const row = m.target.daemon.store
          .statement("SELECT state FROM transfer_incoming WHERE transfer_id=?")
          .get(running?.transferId ?? "");
        if (row?.["state"] !== "cancelled") throw new Error("Not cancelled there yet");
      },
      { timeout: 30_000, interval: 10 },
    );
    return prepare(command, signal);
  });
  await m.here.command({
    type: "thread.continueOn",
    threadId: source.threadId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  await vi.waitFor(
    () => {
      if (!cancelled) throw new Error("Not preparing yet");
    },
    { timeout: 60_000, interval: 20 },
  );
  await cancelled;
  expect((await m.settled()).phase).toBe("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(
    m.target.daemon.store
      .statement("SELECT id FROM threads WHERE title=?")
      .all("Login bug (from MacBook)"),
  ).toEqual([]);
});
