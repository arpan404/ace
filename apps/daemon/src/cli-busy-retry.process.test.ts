import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, expect, test } from "vitest";
import { Client, webSocketTransport } from "@ace/client";
import { CommandId, DeviceId, WorkspaceId, type CommandPayload } from "@ace/protocol";
import { waitSelection } from "./cli/connection.ts";
import { command } from "./cli/mutations.ts";
import { cliStorage } from "./cli/storage.ts";
import { projectFixture, projectServer } from "./projects-test-support.ts";
import { token } from "./socket-test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** One `ace` invocation: the CLI's client, outbox and command path, in its own process state. */
async function invocation(url: string, home: string) {
  const persistence = cliStorage(home);
  const client = new Client({
    deviceId: DeviceId.parse("ace-cli"),
    transport: () => webSocketTransport(() => new WebSocket(url)),
    credential: async () => token,
    storage: persistence.storage,
    scheduler: {
      set(ms, callback) {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    // The middle of the client's retry jitter, so retries are spaced as they usually are.
    random: () => 0.5,
    id: randomUUID,
    now: Date.now,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close();
    persistence.close();
  };
  cleanups.push(close);
  await client.start();
  await waitSelection(
    client.connectionState(),
    (state) => state === "ready",
    AbortSignal.timeout(10_000),
  );
  return {
    run: (payload: CommandPayload, key: string) =>
      command(client, payload, key, AbortSignal.timeout(30_000)),
    close,
  };
}

/** A daemon whose project actions `fill` takes up: 16 lock clears that wait until `release`. */
async function busyDaemon() {
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const f = await projectFixture({
    clearLock: async () => {
      await held;
      return { ok: true };
    },
  });
  cleanups.push(() => f.close());
  const server = await projectServer(f);
  cleanups.push(() => server.close());
  const project = async (name: string) => {
    const path = join(f.root, name);
    await mkdir(path);
    const added = await f.command({ type: "workspace.add", path });
    return { path, id: WorkspaceId.parse(added.workspace?.id) };
  };
  const fill = async () => {
    const owner = await server.connect();
    // Commands on one project run in order, so each held action takes a project of its own.
    for (let index = 0; index < 16; index++) {
      const { id } = await project(`held-${index}`);
      owner.send({
        type: "command",
        command: {
          id: CommandId.parse(`held-${index}`),
          deviceId: DeviceId.parse("owner"),
          payload: { type: "workspace.git.lock.clear", workspaceId: id },
        },
      });
    }
  };
  const home = await realpath(await mkdtemp(join(tmpdir(), "ace-cli-home-")));
  return { f, server, project, fill, release: () => release(), home };
}

const settles = (promise: Promise<unknown>, milliseconds: number) =>
  Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);

test("a command ace refused as busy runs once under its key, and retrying that key after lost output never runs it again", async () => {
  const { f, server, project, fill, release, home } = await busyDaemon();
  const { id } = await project("renamed");
  await fill();
  const first = await invocation(server.url, home);
  const rename = first.run({ type: "workspace.rename", workspaceId: id, name: "A" }, "rename-a");
  // ace is at capacity: the rename waits instead of failing, and changes nothing yet.
  expect(await settles(rename, 500)).toBe(false);
  expect(f.store.getWorkspace(id)?.name).toBe("renamed");
  release();
  await expect(rename).resolves.toMatchObject({ ok: true, idempotencyKey: "rename-a" });
  expect(f.store.getWorkspace(id)?.name).toBe("A");
  // Its output is lost; the person renames again, then retries the first key.
  await first.close();
  const second = await invocation(server.url, home);
  await second.run({ type: "workspace.rename", workspaceId: id, name: "B" }, "rename-b");
  await expect(
    second.run({ type: "workspace.rename", workspaceId: id, name: "A" }, "rename-a"),
  ).resolves.toMatchObject({ ok: true });
  expect(f.store.getWorkspace(id)?.name).toBe("B");
}, 60_000);

test("a key that ends in a number never shares an identity with the key before it", async () => {
  const { f, server, project, fill, release, home } = await busyDaemon();
  const cli = await invocation(server.url, home);
  const a = await project("project-a");
  const b = join(f.root, "project-b");
  await mkdir(b);
  await expect(cli.run({ type: "workspace.add", path: a.path }, "build.1")).resolves.toMatchObject({
    workspace: { id: a.id },
  });
  await fill();
  // "build" registers project B while ace is busy, and gets B, never A's receipt.
  const adding = cli.run({ type: "workspace.add", path: b }, "build");
  expect(await settles(adding, 500)).toBe(false);
  release();
  const added = await adding;
  expect(added.workspace?.id).not.toBe(a.id);
  expect(f.store.getWorkspace(WorkspaceId.parse(added.workspace?.id))?.path).toBe(b);
}, 60_000);
