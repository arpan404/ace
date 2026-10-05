import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
const hostBoundary = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, homedir: () => hostBoundary.home || os.homedir() };
});
import { startDaemon, AdapterRegistry } from "@ace/daemon";
import { CursorTranslator, cursorCapabilities } from "@ace/adapter-cursor";
import { Command, DeviceId } from "@ace/protocol";
import { Client } from "./socket-test-support.ts";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

it.each(["default", "explicit", "environment"])(
  "registers the %s SDK home for thread execution and browser auth",
  async (selection) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-default-account-")));
    hostBoundary.home = root;
    const homeDir =
      selection === "default"
        ? join(root, "daemon", "instances", "cursor-sdk-default")
        : join(root, "original-sdk-home");
    const entry = join(root, "sdk-boundary.mjs");
    await writeFile(
      entry,
      `
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const result = request.method === 'open' ? {agentId:process.env.HOME} :
    request.method === 'status' ? {status:'logged-out',source:'none'} :
    request.method === 'send' ? {runId:'offline-run'} : {disposed:true};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});`,
    );
    const registry = new AdapterRegistry();
    registry.register(
      {
        provider: "cursor",
        backend: "cursor-sdk",
        capabilities: () => cursorCapabilities,
        createTranslator: (init) => new CursorTranslator(init),
        async openSession() {
          throw new Error("Default SDK bypassed accounts ownership");
        },
      },
      { installed: true, auth: "unknown", loginHint: "offline" },
    );
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      const { readConfig } = await import("./config.ts");
      daemon = await startDaemon({
        config: {
          ...readConfig(
            {
              ACE_HOME: join(root, "daemon"),
              ...(selection === "environment" ? { ACE_CURSOR_SDK_HOME: homeDir } : {}),
            },
            root,
          ),
          dataDir: join(root, "daemon"),
          host: "127.0.0.1",
          port: 0,
          remotePort: 0,
          listen: "local",
          logLevel: "silent",
        },
        engine: {
          registry,
          threadId: () => "default-thread",
          cursor: {
            ...(selection === "explicit"
              ? { instance: { id: "cursor-sdk-default", homeDir } }
              : {}),
            env: {},
            entry,
            policy: "full-access",
            discovery: {
              platform: "linux",
              arch: "x64",
              nodeVersion: "24.0.0",
              resolve: (id) => (id === "@cursor/sdk" ? "/sdk/index.js" : "/helper/package.json"),
              read: async (path) =>
                path === "/sdk/package.json"
                  ? '{"name":"@cursor/sdk","version":"1.0.35"}'
                  : '{"name":"@cursor/sdk-linux-x64","version":"1.0.35"}',
              executable: async () => {},
            },
          },
        },
      });
      expect(
        await daemon.accounts?.handle({ type: "accounts.list", requestId: "list" }),
      ).toMatchObject({
        accounts: expect.arrayContaining([
          expect.objectContaining({ id: "cursor-sdk-default", implicit: false }),
          expect.objectContaining({ id: "cursor-cli-default", implicit: true }),
        ]),
      });
      expect(
        await daemon.cursorAuth?.handle("device", {
          type: "cursor.auth.status",
          requestId: "status",
          instanceId: "cursor-sdk-default",
        }),
      ).toMatchObject({
        type: "cursor.auth.changed",
        auth: { status: "logged-out", source: "none" },
      });
      const token = await readFile(daemon.tokenPath, "utf8");
      const client = new Client(daemon.url);
      try {
        await once(client.socket, "open");
        client.send({
          type: "hello",
          protocolVersion: 1,
          deviceId: DeviceId.parse("fixture-cli"),
          token,
        });
        await client.next();
        client.send({
          type: "cursor.auth.status",
          requestId: "fixture-auth-status",
          instanceId: "cursor-sdk-default",
        });
        expect(await client.next()).toMatchObject({
          type: "cursor.auth.changed",
          auth: { status: "logged-out", source: "none" },
        });
      } finally {
        await client.close();
      }
      const workspaceId = daemon.store.createWorkspace(root, "Default account workspace");
      const command = Command.parse({
        id: "create",
        deviceId: "device",
        payload: {
          type: "thread.create",
          provider: "cursor",
          workspaceId,
          input: [{ type: "text", text: "offline boundary" }],
        },
      });
      expect(daemon.engine?.handler.handle(command, daemon.store)).toMatchObject({ ok: true });
      await daemon.engine?.flush();
      expect(
        daemon.store.atomic((db) =>
          db
            .prepare("SELECT instance_id,native_session_id FROM engine_sessions WHERE thread_id=?")
            .get("default-thread"),
        ),
      ).toMatchObject({
        instance_id: "cursor-sdk-default",
        native_session_id: join(homeDir, "user"),
      });
    } finally {
      await daemon?.close();
      await registry.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
