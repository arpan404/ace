import { expect, test } from "vitest";
import type { AppUpdateReply, AppUpdateReport, ServerMessage } from "@ace/protocol";
import { accessRequest } from "./client-access.ts";
import { memoryRecord } from "./machine-update/record.ts";
import { setup } from "./remote-test-support.ts";
import { token } from "./socket-test-support.ts";

/*
 * The wiring of remote updates through a real daemon server: who may start one, and the desktop
 * app hearing what to do in the reply to its own report. The rules are covered in
 * machine-update/*.test.ts.
 */

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>>;

async function next<T extends ServerMessage["type"]>(client: Client, type: T) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

const downloaded: AppUpdateReport = {
  version: "0.0.18",
  available: "0.0.19",
  downloaded: true,
  restartRequired: true,
  releaseUrl: "https://github.com/arpan404/ace/releases/tag/v0.0.19",
  state: "downloaded",
  inPlace: true,
};

async function desktopMachine() {
  const f = await setup({
    version: "0.0.18",
    machineUpdate: {
      install: "desktop",
      record: memoryRecord(),
      platform: "darwin",
      arch: "arm64",
    },
  });
  const report = async (body: AppUpdateReport) =>
    (await accessRequest(f.server.httpUrl, "/v1/app-update", {
      method: "PUT",
      token,
      body,
    })) as AppUpdateReply;
  const device = async (scopes: string[]) => {
    const paired = await f.pair(scopes);
    const client = await f.connectTicket(paired.device.id, (await f.ticket(paired.token)).ticket);
    await client.next();
    return client;
  };
  return { f, report, device };
}

test("a read-only device sees the update on offer but can't start it", async () => {
  const { report, device } = await desktopMachine();
  await report(downloaded);
  const phone = await device(["read"]);
  phone.send({ type: "machineUpdate.request", requestId: "read", operation: "status" });
  expect(await next(phone, "machineUpdate.result")).toMatchObject({
    ok: true,
    update: {
      version: "0.0.18",
      platform: "darwin",
      install: "desktop",
      state: "ready",
      available: "0.0.19",
    },
  });
  phone.send({
    type: "machineUpdate.request",
    requestId: "start",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  expect(await next(phone, "machineUpdate.result")).toMatchObject({
    ok: false,
    error: "forbidden",
  });
  expect((await report(downloaded)).instruction ?? null).toBeNull();
});

test("an admin's update when idle waits for the working thread, then the app hears to install", async () => {
  const { f, report, device } = await desktopMachine();
  await report(downloaded);
  const admin = await device(["read", "operate", "admin"]);
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  admin.send({
    type: "machineUpdate.request",
    requestId: "start",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  expect(await next(admin, "machineUpdate.result")).toMatchObject({
    ok: true,
    update: { state: "waiting", busy: 1, ask: { mode: "idle", version: "0.0.19" } },
  });
  expect((await report(downloaded)).instruction?.action).not.toBe("install");

  f.store.appendEvents(f.thread.id, [{ type: "thread.updated", status: { state: "done" } }]);
  // The app hears it with its next report.
  await expect
    .poll(async () => (await report(downloaded)).instruction)
    .toMatchObject({
      action: "install",
      mode: "idle",
      version: "0.0.19",
    });
  await report({ ...downloaded, state: "installing" });
  expect(await next(admin, "machineUpdate.changed")).toMatchObject({
    update: { state: "installing" },
  });
});

test("an update now needs every working agent confirmed before the app is told", async () => {
  const { f, report, device } = await desktopMachine();
  await report(downloaded);
  const admin = await device(["read", "operate", "admin"]);
  f.store.appendEvents(f.thread.id, [
    { type: "thread.updated", status: { state: "working", agents: 1 } },
  ]);
  const now = (agents: number) =>
    admin.send({
      type: "machineUpdate.request",
      requestId: `now-${agents}`,
      operation: "start",
      mode: "now",
      version: "0.0.19",
      agents,
    });
  now(0);
  expect(await next(admin, "machineUpdate.result")).toMatchObject({
    ok: false,
    error: "confirm",
    update: { busy: 1 },
  });
  expect((await report(downloaded)).instruction ?? null).toBeNull();
  now(1);
  expect(await next(admin, "machineUpdate.result")).toMatchObject({ ok: true });
  await expect
    .poll(async () => (await report(downloaded)).instruction)
    .toMatchObject({
      action: "install",
      mode: "now",
    });
});

test("a daemon without remote updates says so instead of failing", async () => {
  const f = await setup();
  const desk = await f.connect();
  await desk.next();
  desk.send({ type: "machineUpdate.request", requestId: "read", operation: "status" });
  expect(await next(desk, "machineUpdate.result")).toMatchObject({
    ok: false,
    error: "unavailable",
  });
});
