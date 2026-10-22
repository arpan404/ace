import { expect, test } from "vitest";
import { DeviceId, SocketTicket, type ServerMessage } from "@ace/protocol";
import { accessRequest } from "../client-access.ts";
import { fixture, type Client } from "../socket-test-support.ts";
import { verifyFixture } from "./verify-test-support.ts";

async function next<T extends ServerMessage["type"]>(client: Client, type: T) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message as Extract<ServerMessage, { type: T }>;
  }
}

test("a read-only device hears every change to a run but can't start or cancel one", async () => {
  const v = await verifyFixture();
  const f = await fixture({ verify: v.verify });
  try {
    v.setCommand("echo ok");
    const head = await v.pr(7, { "pr.txt": "work\n" });
    const device = f.store.devices.create("Reader", ["read"], 1000);
    const ticket = SocketTicket.parse(
      await accessRequest(f.server.httpUrl, "/v1/tickets", { method: "POST", token: device.token }),
    );
    const reader = await f.open();
    reader.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: DeviceId.parse(device.device.id),
      ticket: ticket.ticket,
    });
    await next(reader, "welcome");
    const operator = await f.connect();
    await next(operator, "welcome");

    const target = v.check(7, head);
    reader.send({
      type: "verify.request",
      requestId: "sneak",
      op: { action: "start", workspaceId: v.workspaceId, target },
    });
    expect(await next(reader, "verify.result")).toEqual({
      type: "verify.result",
      requestId: "sneak",
      ok: false,
      error: "forbidden",
    });

    operator.send({
      type: "verify.request",
      requestId: "go",
      op: { action: "start", workspaceId: v.workspaceId, target },
    });
    const started = await next(operator, "verify.result");
    expect(started).toMatchObject({ ok: true, run: { target } });
    const id = started.run?.id ?? "";

    let pushed = await next(reader, "verify.changed");
    while (pushed.run.id !== id || pushed.run.state !== "passed")
      pushed = await next(reader, "verify.changed");
    expect(pushed.run).toMatchObject({ state: "passed", exitCode: 0 });

    reader.send({ type: "verify.request", requestId: "stop", op: { action: "cancel", runId: id } });
    expect(await next(reader, "verify.result")).toMatchObject({ ok: false, error: "forbidden" });
    reader.send({ type: "verify.request", requestId: "log", op: { action: "log", runId: id } });
    expect(await next(reader, "verify.result")).toMatchObject({
      ok: true,
      log: { text: "$ echo ok\nok\n", truncated: false },
    });
    reader.send({
      type: "verify.request",
      requestId: "list",
      op: { action: "list", workspaceId: v.workspaceId },
    });
    expect(await next(reader, "verify.result")).toMatchObject({
      ok: true,
      command: "echo ok",
      runs: [{ id, state: "passed" }],
    });
  } finally {
    await f.close();
    await v.close();
  }
});
