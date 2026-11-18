import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CommandId, HostId, ThreadId } from "@ace/protocol";
import {
  git,
  registered,
  repositoryWithOrigin,
  transferMachines,
} from "./transfer-test-support.ts";
import { writeFile } from "node:fs/promises";

/** Folders the target made for projects. */
const made = async (root: string) => (await readdir(root)).toSorted();

it("refuses a machine whose link doesn't allow projects, saying how to link it again", async () => {
  const m = await transferMachines({ scopes: ["read", "operate"] });
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: true,
  });
  expect(receipt).toMatchObject({ ok: false, error: "machine_forbidden" });
  expect(receipt.detail).toMatch(/Allow projects for it on Studio/);
  expect(m.source.daemon.transfers.outgoing.list()).toEqual([]);
  expect(await made(m.targetRoot)).toEqual([]);
});

it("a link allowed Projects there takes the transfer it refused, without pairing again", async () => {
  const m = await transferMachines({ scopes: ["read", "operate"] });
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const send = () =>
    m.here.command({
      type: "workspace.transfer",
      workspaceId,
      hostId: m.targetHostId,
      includeChanges: true,
    });
  expect(await send()).toMatchObject({ ok: false, error: "machine_forbidden" });
  expect((await m.here.links())[0]).toMatchObject({ projects: false });

  const studio = await m.targetWindow();
  const allow = {
    op: "scope",
    commandId: CommandId.parse("allow-projects"),
    deviceId: m.linkDevice,
    scope: "projects",
    allowed: true,
  } as const;
  expect(await studio.fleet(allow)).toMatchObject({
    kind: "scoped",
    device: { id: m.linkDevice, scopes: ["read", "operate", "projects"] },
  });
  // The source holds the same credential and sees the change on its next look.
  expect((await m.here.links())[0]).toMatchObject({ projects: true });
  expect(await send()).toMatchObject({ ok: true });
  expect(await m.settled()).toMatchObject({ phase: "completed" });

  // Narrowing works the same way, and the next transfer is refused again.
  expect(
    await studio.fleet({ ...allow, commandId: CommandId.parse("stop-projects"), allowed: false }),
  ).toMatchObject({ kind: "scoped", device: { scopes: ["read", "operate"] } });
  expect(await send()).toMatchObject({ ok: false, error: "machine_forbidden" });
  // A retry of the first command answers its first outcome; it doesn't allow Projects again.
  expect(await studio.fleet(allow)).toMatchObject({
    kind: "scoped",
    device: { scopes: ["read", "operate"] },
  });
}, 120_000);

it("refuses a machine this one has no link to", async () => {
  const m = await transferMachines();
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  const workspaceId = await m.addProject(m.source, path);
  const receipt = await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: HostId.parse("host-nobody-linked"),
    includeChanges: true,
  });
  expect(receipt).toMatchObject({ ok: false, error: "machine_not_linked" });
  expect(receipt.detail).toMatch(/Settings › Fleet/);
});

it("fails a transfer whose file arrives damaged, and registers nothing there", async () => {
  const m = await transferMachines({
    transport: (inner) => (profile, route, options) =>
      inner(
        profile,
        route.method === "PUT" && Buffer.isBuffer(route.body)
          ? {
              ...route,
              body: Buffer.concat([
                Buffer.from([(route.body[0] ?? 0) ^ 0xff]),
                route.body.subarray(1),
              ]),
            }
          : route,
        options,
      ),
  });
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  // A commit origin doesn't have, so a bundle travels.
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  const workspaceId = await m.addProject(m.source, path);
  const projectsBefore = registered(m.target);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  const transfer = await m.settled();
  expect(transfer).toMatchObject({ phase: "failed", error: { code: "transfer_corrupt" } });
  expect(registered(m.target)).toEqual(projectsBefore);
  expect(await made(m.targetRoot)).toEqual([]);
  expect(await readdir(join(m.target.h.home, "daemon", "transfers", "incoming"))).toEqual([]);
});

it("cancels a transfer before it lands, on both machines", async () => {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const m = await transferMachines({
    transport: (inner) => async (profile, route, options) => {
      if (route.method === "PUT") await held;
      return inner(profile, route, options);
    },
  });
  const { path } = await repositoryWithOrigin(m.sourceRoot, "app");
  await writeFile(join(path, "local.txt"), "local\n");
  await git(path, "add", "-A");
  await git(path, "commit", "-m", "local");
  const workspaceId = await m.addProject(m.source, path);
  await m.here.command({
    type: "workspace.transfer",
    workspaceId,
    hostId: m.targetHostId,
    includeChanges: false,
  });
  const [running] = m.source.daemon.transfers.outgoing.list();
  if (!running) throw new Error("No transfer");
  const answer = await m.here.request({ op: "cancel", transferId: running.transferId });
  release();
  expect(answer).toMatchObject({ kind: "cancelled", transfer: { phase: "cancelled" } });
  const listed = await m.here.request({ op: "list" });
  expect(listed).toMatchObject({
    kind: "list",
    transfers: [{ transferId: running.transferId, phase: "cancelled" }],
  });
  expect(await made(m.targetRoot)).toEqual([]);
  expect(await readdir(join(m.source.h.home, "daemon", "transfers", "outgoing"))).toEqual([]);
  expect(m.here.progress().at(-1)?.phase).toBe("cancelled");
});

it("refuses to continue a thread this machine doesn't have, saying so", async () => {
  const m = await transferMachines();
  const receipt = await m.here.command({
    type: "thread.continueOn",
    threadId: ThreadId.parse("thread-nowhere"),
    hostId: m.targetHostId,
    includeChanges: true,
  });
  expect(receipt).toMatchObject({ ok: false, error: "thread_not_found", code: "thread_not_found" });
  expect(receipt.detail).toMatch(/doesn't exist/);
});
