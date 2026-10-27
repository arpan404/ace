import { expect, test } from "vitest";
import { Command, type ServerMessage } from "@ace/protocol";
import { accessRequest } from "./client-access.ts";
import { token } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>>;

/** The next message of a type, skipping pushes the test doesn't name. */
async function next<T extends ServerMessage["type"]>(client: Client, type: T) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

const create = (id: string, workspaceId: string) => ({
  type: "command" as const,
  command: Command.parse({
    id,
    deviceId: "device",
    payload: {
      type: "thread.create",
      workspaceId,
      provider: "codex",
      title: id,
      input: [{ type: "text", text: "test" }],
    },
  }),
});

test("a paired phone pauses new work, every watching client hears it, and resuming reopens it", async () => {
  const f = await setup();
  const desk = await f.connect();
  await desk.next();
  desk.send({ type: "admission.request", requestId: "watch", operation: "status" });
  expect(await next(desk, "admission.result")).toMatchObject({
    ok: true,
    admission: { paused: false },
  });

  const device = await f.pair(["read", "operate"]);
  const phone = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await phone.next();
  phone.send({ type: "admission.request", requestId: "pause", operation: "pause" });
  expect(await next(phone, "admission.result")).toMatchObject({
    ok: true,
    admission: { paused: true },
  });
  expect(await next(desk, "admission.changed")).toMatchObject({ admission: { paused: true } });
  // The desktop tray reads the same gate.
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toMatchObject({
    draining: true,
  });
  desk.send(create("paused-create", f.workspace));
  expect(await next(desk, "error")).toMatchObject({ code: "maintenance", retryable: true });

  phone.send({ type: "admission.request", requestId: "resume", operation: "resume" });
  expect(await next(phone, "admission.result")).toMatchObject({ admission: { paused: false } });
  expect(await next(desk, "admission.changed")).toMatchObject({ admission: { paused: false } });
  desk.send(create("resumed-create", f.workspace));
  expect(await next(desk, "commandResult")).toMatchObject({ ok: true });
});

test("the tray's pause reaches a watching client", async () => {
  const f = await setup();
  const desk = await f.connect();
  await desk.next();
  desk.send({ type: "admission.request", requestId: "watch", operation: "status" });
  await next(desk, "admission.result");
  await accessRequest(f.server.httpUrl, "/v1/maintenance", { method: "POST", token });
  expect(await next(desk, "admission.changed")).toMatchObject({ admission: { paused: true } });
});

test("a view-only phone reads whether new work is paused but can't pause it", async () => {
  const f = await setup();
  const device = await f.pair(["read"]);
  const phone = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
  await phone.next();
  phone.send({ type: "admission.request", requestId: "read", operation: "status" });
  expect(await next(phone, "admission.result")).toMatchObject({
    ok: true,
    admission: { paused: false },
  });
  phone.send({ type: "admission.request", requestId: "pause", operation: "pause" });
  expect(await next(phone, "admission.result")).toEqual({
    type: "admission.result",
    requestId: "pause",
    ok: false,
    error: "forbidden",
  });
  expect(await accessRequest(f.server.httpUrl, "/v1/maintenance", { token })).toMatchObject({
    draining: false,
  });
});
