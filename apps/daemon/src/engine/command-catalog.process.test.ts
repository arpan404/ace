import { ProviderPayload } from "@ace/provider-kit/payload";
import { expect, test } from "vitest";
import { CommandLibrary } from "@ace/commands";
import { DeviceId } from "@ace/protocol";
import { once } from "node:events";
import { join } from "node:path";
import { startServer } from "../server.ts";
import { Client, token } from "../socket-test-support.ts";
import { harness, scriptFrames } from "./test-support.ts";

const cases = [
  {
    provider: "claude",
    channel: "sdk",
    data: { type: "system", subtype: "init", slash_commands: ["explain"] },
  },
  {
    provider: "acp",
    channel: "stdio",
    data: {
      method: "session/update",
      params: {
        sessionId: "native-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "explain", description: "Explain code" }],
        },
      },
    },
  },
  {
    provider: "pi",
    channel: "stdio",
    data: {
      type: "response",
      id: "ace-1",
      command: "get_commands",
      success: true,
      data: {
        commands: [
          { name: "explain", description: "Explain code", source: "prompt" },
          { name: "ace-context", source: "extension" },
          { name: "ace-rollback", source: "extension" },
          { name: "ace-permissions", source: "extension" },
        ],
      },
    },
  },
  {
    provider: "opencode",
    channel: "commands.runtime",
    data: {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "explain", description: "Explain code" }],
    },
  },
] as const;
for (const { provider, channel, data } of cases) {
  test(`${provider} native commands join ace commands over the socket and expire when the session closes`, async () => {
    let library: CommandLibrary | undefined;
    let updated = Promise.resolve();
    const h = await harness([], scriptFrames(), {
      provider,
      onCommandEvent(event) {
        if (event.type === "session.closed") library?.clearRuntime(event.threadId);
        else
          updated =
            library?.updateRuntime(event.threadId, event.data).then(() => {}) ?? Promise.resolve();
      },
    });
    library = new CommandLibrary({
      aceHome: join(h.home, "ace"),
      instances: [],
      now: () => h.clock.now(),
      context: () => ({ workspace: h.home, provider, instance: provider }),
    });
    const server = await startServer({
      port: 0,
      token,
      hostId: "test",
      store: h.store,
      engine: h.engine,
      handler: h.engine.handler,
      commands: library,
    });
    const client = new Client(server.url);
    try {
      await once(client.socket, "open");
      const id = await h.create();
      const payload = new ProviderPayload(JSON.stringify(data));
      await h.contexts[0]?.onFrame({
        dir: "recv",
        channel,
        data: payload.data,
        payload,
        seq: 100,
        t: 100,
      });
      await h.engine.flush();
      await updated;
      client.send({ type: "hello", protocolVersion: 1, deviceId: DeviceId.parse("reader"), token });
      expect((await client.next()).type).toBe("welcome");
      client.send({ type: "commands.list", requestId: "list", threadId: id, query: "", limit: 50 });
      const result = await client.next();
      if (result.type !== "commands.list.result") throw new Error("Missing command catalog");
      expect(result.commands.map((c) => c.id)).toContain("ace#review");
      expect(result.commands.map((c) => c.name)).not.toContain("ace-context");
      expect(result.commands.map((c) => c.name)).not.toContain("ace-rollback");
      expect(result.commands.map((c) => c.name)).not.toContain("ace-permissions");
      const native = result.commands.find((c) => c.name === "explain");
      if (!native) throw new Error("Native command was not discovered");
      expect(await library.resolve(id, native.id, {}, ["src/main.ts"])).toMatchObject({
        ok: true,
        plan: { kind: "native", text: "/explain src/main.ts" },
      });
      await h.engine.close();
      expect((await library.list(id, "explain", 50)).commands).toEqual([]);
    } finally {
      await client.close();
      await server.close();
      await h.close();
      await library.close();
    }
  });
}
