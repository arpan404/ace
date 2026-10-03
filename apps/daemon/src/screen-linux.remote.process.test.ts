import { expect, it } from "vitest";
import { ScreenManager } from "@ace/screen";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setup, cleanups } from "./remote-test-support.ts";

it("paired viewers cannot approve applications, enable capture, or acquire input control", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screen-scopes-"));
  let id = 0;
  const screen = new ScreenManager({
    command: process.execPath,
    args: [
      new URL("../../../packages/screen/src/testing/fake-helper-linux.ts", import.meta.url).pathname,
    ],
    protocolVersion: 2,
    nextId: () => `screen-${++id}`,
    recordingDirectory: directory,
    publishArtifact: async () => {},
  });
  cleanups.push(async () => {
    await screen.close();
    await rm(directory, { recursive: true, force: true });
  });
  const f = await setup({ screen });
  const viewer = await f.pair(["read"]);
  const issued = await f.ticket(viewer.token);
  const client = await f.connectTicket(viewer.device.id, issued.ticket);
  expect(await client.next()).toMatchObject({ type: "welcome" });
  for (const [operation] of [
    [{ op: "enable", enabled: true }, "admin"],
    [{ op: "approve", bundleId: "dev.ace.test", allowed: true }, "admin"],
    [{ op: "controller", sessionId: "missing", controller: "human" }, "operate"],
  ] as const) {
    client.send({ type: "screen.request", requestId: operation.op, operation });
    expect(await client.next()).toMatchObject({
      type: "error",
      code: "forbidden",
    });
  }
  client.send({ type: "screen.request", requestId: "read", operation: { op: "sessions" } });
  expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
  const operator = await f.pair(["read", "operate"]);
  const operatorTicket = await f.ticket(operator.token);
  const operatorClient = await f.connectTicket(operator.device.id, operatorTicket.ticket);
  expect(await operatorClient.next()).toMatchObject({ type: "welcome" });
  operatorClient.send({
    type: "screen.request",
    requestId: "approve",
    operation: { op: "approve", bundleId: "dev.ace.test", allowed: true },
  });
  expect(await operatorClient.next()).toMatchObject({
    type: "error",
    code: "forbidden",
  });
  await screen.enable(true);
  await screen.approve("dev.ace.test", true);
  operatorClient.send({
    type: "screen.request",
    requestId: "start",
    operation: {
      op: "start",
      fps: 10,
      target: { kind: "window", windowId: 1, bundleId: "dev.ace.test" },
    },
  });
  let result = await operatorClient.next();
  while (result.type === "screen.state") result = await operatorClient.next();
  expect(result).toMatchObject({ type: "error", code: "forbidden" });
});
