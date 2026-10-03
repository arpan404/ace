import { afterEach, expect, test } from "vitest";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, readConfig } from "@ace/daemon";
import { Command, DeviceId } from "@ace/protocol";
import type { DiscoveryResult, Provider } from "@ace/provider-kit/discovery";
import { Client } from "../socket-test-support.ts";
import { until } from "./test-support.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

test.each(["claude", "codex", "opencode", "cursor", "cursor-sdk"] as const)(
  "daemon uses installed %s discovery before accepting a workspace",
  async (provider) => {
    const sdk = provider === "cursor-sdk";
    const kind = sdk ? "cursor" : provider;
    for (const installed of [true, false]) {
      const home = mkdtempSync(join(tmpdir(), "ace-discovery-"));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "unused" };
      const discovered: Record<Provider, DiscoveryResult> = {
        claude: absent,
        codex: absent,
        cursor: absent,
        opencode: absent,
        [kind]: {
          installed: sdk ? false : installed,
          auth: "logged_in",
          version: "2.1.286",
          path: "/not-a-real-cli",
          loginHint: "unused",
        },
      };
      const daemon = await startDaemon({
        config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
        engine: {
          adapterDiscovery: async () => discovered,
          // Both CLI and SDK discovery are isolated from the checkout.
          cursor: {
            instance: { id: "cursor-sdk-default", homeDir: join(home, "sdk-account") },
            discovery: {
              platform: "linux",
              arch: "x64",
              nodeVersion: "24.0.0",
              resolve(id) {
                if (!sdk || !installed)
                  throw Object.assign(new Error("Synthetic SDK absence"), {
                    code: "MODULE_NOT_FOUND",
                  });
                return id === "@cursor/sdk" ? "/sdk/index.js" : "/helper/package.json";
              },
              read: async (path) =>
                path === "/sdk/package.json"
                  ? '{"name":"@cursor/sdk","version":"1.0.35"}'
                  : '{"name":"@cursor/sdk-linux-x64","version":"1.0.35"}',
              executable: async () => {},
            },
          },
        },
      });
      cleanups.push(() => daemon.close());
      // A regular file exercises discovery and admission without ever opening a provider session.
      const path = join(home, "file");
      writeFileSync(path, "not a directory");
      const workspaceId = daemon.store.createWorkspace(path, "file");
      const client = new Client(daemon.url);
      cleanups.push(() => client.close());
      await once(client.socket, "open");
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("device"),
        token: readFileSync(daemon.tokenPath, "utf8"),
      });
      await until(client, (message) => message.type === "welcome");
      client.send({
        type: "command",
        command: Command.parse({
          id: "create",
          deviceId: "device",
          payload: {
            type: "thread.create",
            workspaceId,
            provider: kind,
            input: [{ type: "text", text: "unused" }],
          },
        }),
      });
      expect(await until(client, (message) => message.type === "commandResult")).toMatchObject({
        ok: false,
        error: installed ? "workspace_unavailable" : "provider_unavailable",
      });
      expect(daemon.store.listThreads()).toEqual([]);
    }
  },
);
