import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ScreenManager } from "@ace/screen";
import { cleanups, setup } from "./remote-test-support.ts";
import { token, type Client } from "./socket-test-support.ts";
import type { ScreenOperation } from "@ace/protocol";

const target = { kind: "window", bundleId: "dev.ace.test", windowId: 1 } as const;
async function screenFixture(env: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "screen-remote-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
    ],
    env: { FAKE_V2: "1", ...env },
    nextId: () => `screen-${++id}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  cleanups.push(async () => {
    await screen.close();
    await rm(directory, { recursive: true, force: true });
  });
  return screen;
}
async function request(client: Client, requestId: string, operation: ScreenOperation) {
  client.send({ type: "screen.request", requestId, operation });
  while (true) {
    const message = await client.next();
    if (
      message.type === "error" ||
      (message.type === "screen.result" && message.requestId === requestId)
    )
      return message;
  }
}
it("a paired read-only device cannot enable or approve desktop access", async () => {
  const screen = await screenFixture();
  const f = await setup({ screen });
  const device = await f.pair(["read"]);
  const client = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  expect(await client.next()).toMatchObject({ type: "welcome" });
  expect(await request(client, "enable", { op: "enable", enabled: true })).toMatchObject({
    code: "forbidden",
  });
  await expect(screen.start(target)).rejects.toThrow("disabled");
  expect(
    await request(client, "approve", { op: "approve", bundleId: target.bundleId, allowed: true }),
  ).toMatchObject({ code: "forbidden" });
  await screen.enable(true);
  await expect(screen.start(target)).rejects.toThrow("approval");
});
it("revoking a paired admin cancels pending input before it can change the approved app", async () => {
  const screen = await screenFixture({ HOLD_PERMISSION: "1" });
  await screen.enable(true);
  await screen.approve(target.bundleId, true);
  const state = await screen.start(target);
  const f = await setup({ screen });
  const device = await f.pair(["admin"]);
  const client = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  expect(await client.next()).toMatchObject({ type: "welcome" });
  expect(
    await request(client, "control", {
      op: "controller",
      sessionId: state.sessionId,
      controller: "human",
    }),
  ).toMatchObject({ ok: true });
  client.send({
    type: "screen.request",
    requestId: "pending",
    operation: {
      op: "input",
      sessionId: state.sessionId,
      input: { kind: "text.type", text: "must not type" },
    },
  });
  // A ping is an ordered receive checkpoint, then target discovery observes the held helper reply.
  client.send({ type: "ping" });
  while ((await client.next()).type !== "pong") {}
  expect((await screen.targets()).windows[0]?.title).toContain("heldInput:true");
  const closed = once(client.socket, "close");
  await f.request(`/v1/devices/${device.device.id}`, { method: "DELETE", token });
  await closed;
  expect(screen.state(state.sessionId).controller).toBe("none");
  const inspected = new Promise<void>((resolve) => {
    const stop = screen.watch(() => {
      stop();
      resolve();
    });
  });
  await screen.targets(); // Release the held inspection after revocation.
  await inspected;
  expect((await screen.targets()).windows[0]?.title).toContain("actions:0");
  await expect(f.ticket(device.token)).rejects.toThrow("HTTP 401");
});
