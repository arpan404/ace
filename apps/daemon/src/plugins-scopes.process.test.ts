import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { z } from "zod";
import { PluginManager, PluginService } from "@ace/plugins";
import { PluginServerMessage } from "@ace/protocol/plugins";
import { ServerMessage } from "@ace/protocol";
import { expect, test } from "vitest";
import { setup } from "./remote-test-support.ts";

const response = z.union([ServerMessage, PluginServerMessage]);
test("read-only and operate devices cannot change plugin trust while reads remain available", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ace-plugin-scopes-")));
  const manager = await PluginManager.open({ root, now: () => 0, id: randomUUID });
  const sockets: WebSocket[] = [];
  try {
    const f = await setup({ plugins: new PluginService(manager) });
    for (const scopes of [["read"], ["operate"], ["admin"]]) {
      const device = await f.pair(scopes);
      const ticket = await f.ticket(device.token);
      const socket = new WebSocket(f.server.url);
      sockets.push(socket);
      await once(socket, "open");
      async function send(input: unknown) {
        const received = once(socket, "message");
        socket.send(JSON.stringify(input));
        return response.parse(JSON.parse(String((await received)[0])));
      }
      expect(
        await send({
          type: "hello",
          protocolVersion: 1,
          deviceId: device.device.id,
          ticket: ticket.ticket,
        }),
      ).toMatchObject({ type: "welcome" });
      const removed = await send({
        type: "pluginRequest",
        requestId: "remove",
        request: { type: "plugins.remove", name: "sample" },
      });
      if (scopes.includes("admin"))
        expect(removed).toMatchObject({
          type: "pluginResult",
          response: { type: "plugins.removed" },
        });
      else expect(removed).toMatchObject({ type: "error", code: "forbidden" });
      const list = await send({
        type: "pluginRequest",
        requestId: "list",
        request: { type: "plugins.list" },
      });
      if (scopes.includes("operate"))
        expect(list).toMatchObject({ type: "error", code: "forbidden" });
      else
        expect(list).toMatchObject({
          type: "pluginResult",
          response: { type: "plugins.list", installs: [], reviews: [] },
        });
    }
  } finally {
    for (const socket of sockets) socket.terminate();
    manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
