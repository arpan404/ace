import { expect, test } from "vitest";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, readConfig } from "@ace/daemon";
import { Command, DeviceId } from "@ace/protocol";
import { Client } from "../socket-test-support.ts";
import { until } from "./test-support.ts";
test.each(["0.85.1", "1.0.0"])(
  "Pi %s discovery gates thread admission without launching a provider",
  async (version) => {
    const home = await mkdtemp(join(tmpdir(), "ace-pi-discovery-"));
    const absent = { installed: false, auth: "unknown" as const, loginHint: "unused" };
    const daemon = await startDaemon({
      startup: { schedule: () => () => {} },
      config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      engine: {
        cursor: {
          discovery: {
            resolve() {
              throw Object.assign(new Error("SDK absent in Pi fixture"), {
                code: "MODULE_NOT_FOUND",
              });
            },
          },
        },
        adapterDiscovery: async () => ({
          claude: absent,
          codex: absent,
          opencode: absent,
          cursor: absent,
        }),
      },
      pi: {
        runtime: {
          discover: async () => ({
            installed: true,
            path: "/synthetic/pi",
            version,
            auth: "unknown",
            loginHint: "unused",
          }),
          spawn() {
            throw new Error("must not launch");
          },
        },
      },
    });
    expect(daemon.serviceStatus()).toContainEqual({ name: "engine", state: "ready" });
    const client = new Client(daemon.url);
    const opened = once(client.socket, "open");
    try {
      const path = join(home, "file");
      await writeFile(path, "not a directory");
      const workspaceId = daemon.store.createWorkspace(path, "file");
      await opened;
      client.send({
        type: "hello",
        protocolVersion: 1,
        deviceId: DeviceId.parse("device"),
        token: await readFile(daemon.tokenPath, "utf8"),
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
            provider: "pi",
            input: [{ type: "text", text: "unused synthetic admission" }],
          },
        }),
      });
      expect(await until(client, (message) => message.type === "commandResult")).toMatchObject({
        ok: false,
        error: version === "0.85.1" ? "workspace_unavailable" : "provider_unavailable",
      });
      expect(daemon.store.listThreads()).toEqual([]);
    } finally {
      await client.close();
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
