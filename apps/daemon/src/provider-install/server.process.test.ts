import { expect, test } from "vitest";
import { SocketTicket, DeviceId, type ServerMessage } from "@ace/protocol";
import { fixture, type Client } from "../socket-test-support.ts";
import { accessRequest } from "../client-access.ts";
import { installFixture } from "./testing.ts";

async function next(
  client: Client,
  match: (message: ServerMessage) => boolean,
): Promise<ServerMessage> {
  for (;;) {
    const message = await client.next();
    if (match(message)) return message;
  }
}

test("operate clients receive installer progress, can poll after reconnect, and receive refreshed readiness", async () => {
  const f = await installFixture({ managers: ["npm"] });
  const server = await fixture({ providerInstalls: f.installs, providerStatuses: f.statuses });
  try {
    const client = await server.connect();
    client.receiveCatalogPushes = true;
    await client.next();
    client.send({
      type: "provider.install.plan",
      requestId: "plan",
      provider: "codex",
      action: "install",
    });
    expect(
      await next(client, (message) => message.type === "provider.install.result"),
    ).toMatchObject({
      result: {
        ok: true,
        plan: { method: "npm", commands: [{ args: ["install", "-g", "@openai/codex@latest"] }] },
      },
    });
    client.send({
      type: "provider.install.run",
      requestId: "run",
      provider: "codex",
      action: "install",
      method: "npm",
    });
    const started = await next(client, (message) => message.type === "provider.install.result");
    if (
      started.type !== "provider.install.result" ||
      !started.result.ok ||
      !("progress" in started.result)
    )
      throw new Error("Expected session");
    const session = started.result.progress.session;
    const changed = await next(client, (message) => message.type === "providers.changed");
    expect(changed).toMatchObject({
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: "codex", installed: true, version: "2.0.0" }),
      ]),
    });
    expect(
      await next(
        client,
        (message) =>
          message.type === "provider.install.progress" && message.progress.state === "succeeded",
      ),
    ).toMatchObject({ progress: { session, version: "2.0.0", exit: 0 } });
    await client.close();
    const reconnect = await server.connect();
    await reconnect.next();
    reconnect.send({ type: "provider.install.poll", requestId: "poll", session });
    expect(await reconnect.next()).toMatchObject({
      type: "provider.install.result",
      result: { ok: true, progress: { state: "succeeded", session } },
    });
  } finally {
    await server.close();
    await f.close();
  }
});

test("read-only devices cannot plan, run, poll or cancel and receive no installer progress", async () => {
  const f = await installFixture({ managers: ["npm"] });
  const server = await fixture({ providerInstalls: f.installs, providerStatuses: f.statuses });
  try {
    const device = server.store.devices.create("Reader", ["read"], 1000);
    const ticket = SocketTicket.parse(
      await accessRequest(server.server.httpUrl, "/v1/tickets", {
        method: "POST",
        token: device.token,
      }),
    );
    const client = await server.open();
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(device.device.id),
      ticket: ticket.ticket,
    });
    await client.next();
    for (const request of [
      { type: "provider.install.plan", requestId: "plan", provider: "codex", action: "install" },
      {
        type: "provider.install.run",
        requestId: "run",
        provider: "codex",
        action: "install",
        method: "npm",
      },
      { type: "provider.install.poll", requestId: "poll", session: "private" },
      { type: "provider.install.cancel", requestId: "cancel", session: "private" },
    ] as const) {
      client.send(request);
      expect(await client.next()).toMatchObject({
        type: "provider.install.result",
        result: { ok: false, error: "forbidden" },
      });
    }
    expect(await f.calls()).toEqual([]);
  } finally {
    await server.close();
    await f.close();
  }
});
