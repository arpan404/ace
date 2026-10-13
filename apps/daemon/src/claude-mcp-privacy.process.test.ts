import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { Command, SocketTicket } from "@ace/protocol";
import { expect, test } from "vitest";
import { readConfig, startDaemon } from "@ace/daemon";
import { Client } from "./socket-test-support.ts";

const privateValues = [
  "OPAQUE_URL_CREDENTIAL",
  "OPAQUE_HEADER_CREDENTIAL",
  "NATIVE_STATUS_DETAIL",
  "RECOGNIZABLE_BEARER",
];

test("a paired reader receives only MCP names and states, and native configs never enter event storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "ace-claude-mcp-privacy-"));
  const executable = join(home, "claude");
  const script = fileURLToPath(new URL("./testing/claude-controls.ts", import.meta.url));
  await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`);
  await chmod(executable, 0o755);
  const absent = { installed: false, auth: "unknown" as const, loginHint: "local CLI" };
  const daemon = await startDaemon({
    config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "warn" }),
    modelInstances: [],
    engine: {
      adapterDiscovery: async () => ({
        claude: {
          installed: true,
          path: executable,
          version: "2.1.286",
          auth: "unknown",
          loginHint: "local CLI",
        },
        codex: absent,
        opencode: absent,
        cursor: absent,
      }),
    },
    claude: {
      env: { HOME: home },
      mcpServers: {
        "failed-http": {
          type: "http",
          url: "http://127.0.0.1:9/mcp?key=OPAQUE_URL_CREDENTIAL",
          headers: {
            "X-Auth": "OPAQUE_HEADER_CREDENTIAL",
            Authorization: "Bearer RECOGNIZABLE_BEARER",
          },
        },
        "requires-login": { type: "sse", url: "http://127.0.0.1:9/sse?key=OPAQUE_URL_CREDENTIAL" },
      },
    },
    diagnostics: { doctor: async () => ({ at: 1, checks: [] }), toolchains: async () => [] },
  });
  let client: Client | undefined;
  try {
    const engine = daemon.engine;
    if (!engine) throw new Error("Engine unavailable");
    const workspaceId = daemon.store.createWorkspace(home, "Synthetic");
    const command = Command.parse({
      id: "create",
      deviceId: "host",
      payload: {
        type: "thread.create",
        workspaceId,
        provider: "claude",
        input: [{ type: "text", text: "synthetic" }],
      },
    });
    expect(
      daemon.store.recordCommand(command.id, command.deviceId, () =>
        engine.handler.handle(command, daemon.store),
      ).ok,
    ).toBe(true);
    await engine.flush();
    const thread = daemon.store.listThreads()[0];
    if (!thread) throw new Error("Thread unavailable");
    const device = daemon.store.devices.create("Reader", ["read"], 1);
    const ticket = SocketTicket.parse(
      await (
        await fetch(`${daemon.url.replace("ws:", "http:")}/v1/tickets`, {
          method: "POST",
          headers: { Authorization: `Bearer ${device.token}` },
        })
      ).json(),
    );
    client = new Client(daemon.url);
    await once(client.socket, "open");
    client.send({
      type: "hello",
      protocolVersion: 1,
      deviceId: device.device.id,
      ticket: ticket.ticket,
    });
    expect(await client.next()).toMatchObject({ type: "welcome" });
    const inventory = [
      { name: "failed-http", status: "failed" },
      { name: "requires-login", status: "needs_auth" },
    ];
    for (const type of ["mcp.status", "mcp.sources"] as const) {
      client.send({ type, threadId: thread.id, requestId: type });
      const reply = await client.next();
      expect.soft(reply).toMatchObject({
        type: "mcp.result",
        result: type === "mcp.status" ? inventory : { servers: inventory },
      });
      const serialized = JSON.stringify(reply);
      for (const value of privateValues) expect.soft(serialized).not.toContain(value);
      expect.soft(serialized).not.toContain("config");
    }
    await engine.flush();
    // The inventory is served live; Claude's control responses are consumed by its translator
    // and never become events. Nothing native, sanitized or not, may reach storage.
    const stored = JSON.stringify(daemon.store.readEvents({ afterSeq: 0, limit: 256 }));
    for (const value of privateValues) expect.soft(stored).not.toContain(value);
    expect.soft(stored).not.toMatch(/Bearer [a-f0-9]{64}/);
    await client.close();
    await daemon.close();
    const logs = await readFile(join(home, "logs/ace.jsonl"), "utf8").catch(() => "");
    for (const value of privateValues) expect(logs).not.toContain(value);
    const database = [
      await readFile(join(home, "events.sqlite")),
      await readFile(join(home, "events.sqlite-wal")).catch(() => Buffer.alloc(0)),
    ];
    for (const bytes of database)
      for (const value of privateValues) expect(bytes.includes(value)).toBe(false);
  } finally {
    await client?.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
