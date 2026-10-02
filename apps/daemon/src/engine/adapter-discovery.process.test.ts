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

test.each([true, false])(
  "daemon uses installed Claude discovery (%s) before accepting a workspace",
  async (installed) => {
    const home = mkdtempSync(join(tmpdir(), "ace-discovery-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const absent: DiscoveryResult = { installed: false, auth: "unknown", loginHint: "unused" };
    const discovered: Record<Provider, DiscoveryResult> = {
      claude: {
        installed,
        auth: "logged_in",
        version: "2.1.286",
        path: "/not-a-real-cli",
        loginHint: "unused",
      },
      codex: absent,
      cursor: absent,
      opencode: absent,
    };
    const daemon = await startDaemon({
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      engine: {
        adapterDiscovery: async () => discovered,
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
          provider: "claude",
          input: [{ type: "text", text: "unused" }],
        },
      }),
    });
    expect(await until(client, (message) => message.type === "commandResult")).toMatchObject({
      ok: false,
      error: installed ? "workspace_unavailable" : "provider_unavailable",
    });
    expect(daemon.store.listThreads()).toEqual([]);
  },
);
