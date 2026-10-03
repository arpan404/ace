import { expect, it } from "vitest";
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
      { op: "enable", enabled: true } as const,
      { op: "approve", bundleId: "dev.ace.test", allowed: true } as const,
    ]) {
      client.send({ type: "screen.request", requestId: operation.op, operation });
      expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
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
