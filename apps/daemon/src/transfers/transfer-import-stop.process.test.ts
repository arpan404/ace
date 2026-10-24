import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TransferTransport } from "./client.ts";
import {
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

/** A repository with no origin, so the whole history travels as a bundle the target clones. */
async function bundled(m: Machines) {
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await git(path, "remote", "remove", "origin");
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  return m.addProject(m.source, path);
}

it("a cancel while the target is importing leaves no project and no folder there", async () => {
  let machines: Machines | undefined;
  let cancelled: Promise<unknown> | undefined;
  const m = await transferMachines({
    transport: onCommit(async (transferId) => {
      cancelled = machines?.source.daemon.transfers.outgoing.cancel(transferId);
    }),
  });
  machines = m;
  const before = registered(m.target);
  const workspaceId = await bundled(m);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  await vi.waitFor(
    () => {
      if (!cancelled) throw new Error("Not committed yet");
    },
    { timeout: 60_000, interval: 20 },
  );
  await cancelled;
  const transfer = await m.settled();
  expect(transfer.phase).toBe("cancelled");
  // Whatever the import had reached, nothing of it stays, and nothing turns up afterwards.
  await new Promise((resolve) => setTimeout(resolve, 1500));
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
