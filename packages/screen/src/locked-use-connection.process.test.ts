import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  LockedUseConnection,
  connectLockedUse,
  openLockedUseConnection,
} from "./locked-use-connection.ts";
import { systemScheduler } from "./runtime.ts";
import {
  fakeLockedUseService,
  fakeLockedUseToken,
  fakeStatus,
} from "./testing/fake-locked-use-service.ts";
import { encodeLockedUseFrame } from "./locked-use-wire.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function socketPath() {
  const dir = await mkdtemp(join(tmpdir(), "ace-luc-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "s.sock");
}

async function service() {
  const fake = await fakeLockedUseService(await socketPath());
  cleanups.push(() => fake.close());
  return fake;
}

let next = 0;
const options = { nextId: () => `r${++next}`, scheduler: systemScheduler, helloTimeoutMs: 300 };

it("the service accepts the daemon's token, and only then answers requests", async () => {
  const fake = await service();
  const connection = await openLockedUseConnection(await connectLockedUse(fake.path), {
    ...options,
    token: fakeLockedUseToken,
  });
  cleanups.push(() => connection.close());
  await expect(connection.request({ type: "status" })).resolves.toMatchObject({
    phase: "disabled",
  });
  expect(fake.hellos).toEqual([fakeLockedUseToken]);
  expect(fake.requests.map((request) => request.type)).toEqual(["status"]);
});

it("a wrong token is refused: the connection closes and no command is ever sent", async () => {
  const fake = await service();
  const socket = await connectLockedUse(fake.path);
  const opened = openLockedUseConnection(socket, { ...options, token: "f".repeat(64) });
  await expect(opened).rejects.toMatchObject({ code: "unauthorized" });
  expect(socket.destroyed).toBe(true);
  expect(fake.hellos).toEqual(["f".repeat(64)]);
  expect(fake.requests).toEqual([]);
});

it("without a hello, a connection sends no command at all", async () => {
  const fake = await service();
  const connection = new LockedUseConnection(await connectLockedUse(fake.path), options);
  cleanups.push(() => connection.close());
  await expect(connection.request({ type: "enable", optIn: true })).rejects.toMatchObject({
    code: "unauthorized",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fake.hellos).toEqual([]);
  expect(fake.requests).toEqual([]);
});

/** A socket server that answers every connection's first frame with `first`, or never. */
async function scripted(first: Record<string, unknown> | undefined) {
  const path = await socketPath();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => {
      if (first)
        socket.write(encodeLockedUseFrame(new TextEncoder().encode(JSON.stringify(first))));
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return path;
}

it("a state, or a reply to anything but the hello, before the accept is a refusal", async () => {
  for (const first of [
    { v: 1, type: "state", status: fakeStatus({ phase: "ready" }) },
    { v: 1, type: "reply", id: "other", ok: true },
  ]) {
    const socket = await connectLockedUse(await scripted(first));
    await expect(
      openLockedUseConnection(socket, { ...options, token: fakeLockedUseToken }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(socket.destroyed).toBe(true);
  }
});

it("a service that never answers the hello is given up on", async () => {
  const socket = await connectLockedUse(await scripted(undefined));
  await expect(
    openLockedUseConnection(socket, { ...options, token: fakeLockedUseToken }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(socket.destroyed).toBe(true);
});
