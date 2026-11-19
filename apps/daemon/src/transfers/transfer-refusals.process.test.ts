import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CommandId, Device, HostId, ThreadId } from "@ace/protocol";
import {
  git,
  registered,
  repositoryWithOrigin,
  transferMachines,
} from "./transfer-test-support.ts";
import { writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { incomingPath } from "./incoming-files.ts";

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
  // A retry of the first command answers its first outcome; it doesn't allow Projects again,
  // so the next transfer is still refused.
  expect(await studio.fleet(allow)).toMatchObject({
    kind: "scoped",
    device: { scopes: ["read", "operate"] },
  });
  expect(await send()).toMatchObject({ ok: false, error: "machine_forbidden" });
}, 120_000);

/** One call on the target's transfer routes, as the source's link sends it. */
function routeCall(
  m: Awaited<ReturnType<typeof transferMachines>>,
  route: { method: "POST" | "PUT"; path: string; body: Buffer },
  /** Run once the first half of the body is in; the rest is sent after it. */
  between: () => Promise<unknown> = async () => undefined,
) {
  /** Whether the target answered before `between` ran, i.e. before it had the whole body. */
  let early = false;
  let answered = false;
  return new Promise<{ status: number; body: unknown; early: boolean }>((resolve, reject) => {
    const sent = httpsRequest(
      `${m.targetOrigin}${route.path}`,
      {
        method: route.method,
        // The test's own self-signed target; the real sender pins its key.
        rejectUnauthorized: false,
        headers: {
          authorization: `Bearer ${m.linkToken}`,
          "content-length": route.body.length,
        },
      },
      (response) => {
        answered = true;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString() || "null"),
            early,
          }),
        );
      },
    );
    sent.on("error", reject);
    const half = Math.floor(route.body.length / 2);
    sent.write(route.body.subarray(0, half));
    // Long enough for the target to have authenticated, admitted the call and begun reading.
    void new Promise((settle) => setTimeout(settle, 200))
      .then(() => {
        early = answered;
      })
      .then(between)
      .then(() => sent.end(route.body.subarray(half)), reject);
  });
}

/** A transfer the link begins on the target, through the same route. */
async function begun(m: Awaited<ReturnType<typeof transferMachines>>, transferId: string) {
  const call = {
    op: "begin",
    transferId,
    origin: { hostId: "host-macbook", hostName: "MacBook" },
    method: "bundle",
    name: "app",
  };
  const answer = await routeCall(m, {
    method: "POST",
    path: "/v1/transfers",
    body: Buffer.from(JSON.stringify(call)),
  });
  expect(answer).toMatchObject({ status: 200, body: { transferId, state: "receiving" } });
}

const chunkRoute = (transferId: string, body: Buffer) => ({
  method: "PUT" as const,
  path: `/v1/transfers/chunk?transfer=${transferId}&offset=0`,
  body,
});

it("a call or chunk whose body is still arriving when Projects is taken away is refused", async () => {
  const m = await transferMachines();
  const studio = await m.targetWindow();
  let turn = 0;
  const allow = (allowed: boolean) => () =>
    studio.fleet({
      op: "scope",
      commandId: CommandId.parse(`narrow-${++turn}`),
      deviceId: m.linkDevice,
      scope: "projects",
      allowed,
    });
  const incoming = m.target.daemon.transfers.incoming;
  const held = (transferId: string) =>
    incoming.call(
      Device.parse({
        id: m.linkDevice,
        name: "MacBook",
        scopes: ["read"],
        createdAt: 0,
        lastSeenAt: 0,
        revokedAt: null,
      }),
      { op: "status", transferId },
    );
  await begun(m, "transfer-slow");
  const bytes = Buffer.alloc(64 * 1024, 1);

  // Left alone, the same slow chunk is taken: the route reads it to the end and appends it.
  const control = await routeCall(m, chunkRoute("transfer-slow", bytes));
  expect(control).toMatchObject({ status: 200, body: { offset: bytes.length } });
  await begun(m, "transfer-narrowed");

  // Admitted and reading its body (no answer yet) when Projects goes: refused, nothing appended.
  const chunk = await routeCall(m, chunkRoute("transfer-narrowed", bytes), allow(false));
  expect(chunk).toMatchObject({ status: 403, body: { error: "machine_forbidden" }, early: false });
  await allow(true)();
  expect(await held("transfer-narrowed")).toMatchObject({ state: "receiving", offset: 0 });

  // A commit of the real transfer, the same way: refused, and it never starts importing.
  await routeCall(m, chunkRoute("transfer-narrowed", bytes));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const commit = await routeCall(
    m,
    {
      method: "POST",
      path: "/v1/transfers",
      body: Buffer.from(
        JSON.stringify({
          op: "commit",
          transferId: "transfer-narrowed",
          file: { bytes: bytes.length, sha256 },
        }),
      ),
    },
    allow(false),
  );
  expect(commit).toMatchObject({ status: 403, body: { error: "machine_forbidden" }, early: false });
  await allow(true)();
  expect(await held("transfer-narrowed")).toMatchObject({ state: "receiving" });
}, 120_000);

it("a chunk whose whole body is in, and whose write is queued when Projects goes, never appends", async () => {
  const m = await transferMachines();
  const studio = await m.targetWindow();
  const incoming = m.target.daemon.transfers.incoming;
  await begun(m, "transfer-queued");
  // The chunk is admitted and handed on to be written; its write waits until Projects is gone.
  const { promise: narrowed, resolve: narrow } = Promise.withResolvers<void>();
  const { promise: queued, resolve: queue } = Promise.withResolvers<void>();
  const write = incoming.chunk.bind(incoming);
  incoming.chunk = async (...args) => {
    queue();
    await narrowed;
    return write(...args);
  };
  const answer = routeCall(m, chunkRoute("transfer-queued", Buffer.alloc(1024, 1)));
  await queued;
  await studio.fleet({
    op: "scope",
    commandId: CommandId.parse("narrow-queued"),
    deviceId: m.linkDevice,
    scope: "projects",
    allowed: false,
  });
  narrow();
  expect(await answer).toMatchObject({ status: 403, body: { error: "machine_forbidden" } });
  const stored = m.target.daemon.store
    .statement("SELECT state FROM transfer_incoming WHERE transfer_id=?")
    .get("transfer-queued");
  expect(stored?.["state"]).toBe("receiving");
  const part = incomingPath(
    join(m.target.h.home, "daemon", "transfers", "incoming"),
    "transfer-queued",
    "code",
  );
  await expect(stat(part)).rejects.toMatchObject({ code: "ENOENT" });
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
