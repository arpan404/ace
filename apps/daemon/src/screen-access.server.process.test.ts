import { expect, it } from "vitest";
import type { Config } from "./config.ts";
import { ScreenManager } from "@ace/screen";
import { cleanups, setup } from "./remote-test-support.ts";

it.each([["read"], ["read", "operate"]])(
  "paired %j devices cannot observe screen state or grant screen approvals",
  async (...scopes) => {
    let id = 0;
    const screen = new ScreenManager({
      command: process.execPath,
      nextId: () => `screen-${++id}`,
      recordingDirectory: "unused-no-recording",
      publishArtifact: async () => {},
    });
    cleanups.push(() => screen.close());
    const f = await setup({ screen });
    const device = await f.pair(scopes);
    const client = await f.connectTicket(device.device.id, (await f.ticket(device.token)).ticket);
    expect(await client.next()).toMatchObject({ type: "welcome" });
    for (const operation of [
      { op: "sessions" } as const,
      { op: "status" } as const,
      { op: "permissions.request", permission: "accessibility" } as const,
      { op: "enable", enabled: true } as const,
      { op: "approve", bundleId: "dev.ace.test", allowed: true } as const,
    ]) {
      const requestId = operation.op.replaceAll(".", "-");
      client.send({ type: "screen.request", requestId, operation });
      expect(await client.next()).toMatchObject({
        type: "screen.result",
        requestId,
        ok: false,
        errorCode: "forbidden",
      });
    }
    await expect(
      screen.start({ kind: "window", bundleId: "dev.ace.test", windowId: 1 }),
    ).rejects.toThrow("disabled");
    const host = await f.connect();
    expect(await host.next()).toMatchObject({ type: "welcome" });
    host.send({ type: "screen.request", requestId: "sessions", operation: { op: "sessions" } });
    expect(await host.next()).toMatchObject({ type: "screen.result", ok: true, data: [] });
  },
);

it("screen enablement pushes reach other devices and status survives a daemon restart", async () => {
  const { startDaemon } = await import("./index.ts");
  const { Client } = await import("./socket-test-support.ts");
  const { DeviceId } = await import("@ace/protocol");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "ace-screen-settings-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let id = 0;
  const makeScreen = () =>
    new ScreenManager({
      command: process.execPath,
      args: [
        new URL("../../../packages/screen/src/testing/fake-helper.ts", import.meta.url).pathname,
      ],
      env: { FAKE_V2: "1" },
      nextId: () => `settings-${++id}`,
      recordingDirectory: "unused-no-recording",
      publishArtifact: async () => {},
    });
  const config: Config = {
    dataDir: directory,
    host: "127.0.0.1",
    port: 0,
    listen: "local",
    remotePort: 0,
    logLevel: "silent",
  };
  let daemon = await startDaemon({ config, screen: makeScreen() });
  cleanups.push(() => daemon.close());
  const token = (await readFile(daemon.tokenPath, "utf8")).trim();
  const connect = async (deviceId: string) => {
    const client = new Client(daemon.url);
    cleanups.push(() => client.close());
    await new Promise<void>((resolve) => client.socket.once("open", resolve));
    client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse(deviceId), token });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    return client;
  };
  const owner = await connect("owner"),
    second = await connect("second-device");
  owner.send({
    type: "screen.request",
    requestId: "enable",
    operation: { op: "enable", enabled: true },
  });
  expect(await owner.next()).toEqual({ type: "screen.enabled", enabled: true });
  expect(await owner.next()).toMatchObject({
    type: "screen.result",
    requestId: "enable",
    ok: true,
  });
  expect(await second.next()).toEqual({ type: "screen.enabled", enabled: true });
  await owner.close();
  await second.close();
  await daemon.close();
  daemon = await startDaemon({ config, screen: makeScreen() });
  const client = await connect("reconnected-device");
  client.send({ type: "screen.request", requestId: "status", operation: { op: "status" } });
  expect(await client.next()).toMatchObject({
    type: "screen.result",
    requestId: "status",
    ok: true,
    data: {
      enabled: true,
      sessions: 0,
      permissions: { screenRecording: true, accessibility: true },
    },
  });
});
