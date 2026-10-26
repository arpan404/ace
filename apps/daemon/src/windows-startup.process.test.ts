import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { WorkspaceId } from "@ace/protocol";
import { accessRequest } from "./client-access.ts";
import { readConfig, startDaemon, stubHandler } from "./index.ts";

test.runIf(process.platform === "win32")(
  "windows daemon cold boot shuts down cleanly then restarts from the same home",
  async () => {
    const base = await mkdtemp(join(tmpdir(), "ace-win-startup-"));
    const home = join(base, "home");
    const workspaceRoot = await mkdtemp(join(tmpdir(), "ace-win-workspace-"));
    try {
      const options = () => ({
        config: readConfig({ ACE_HOME: home, ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
        handler: stubHandler({ development: true }),
        history: { instances: [] },
        modelInstances: [],
        // ProviderStatuses refreshes on construction even with a stub handler, so isolate
        // its PATH and stub only its spawn boundaries. No filesystem/inventory stubs.
        providerStatus: {
          env: { PATH: "" },
          versions: async () => ({}),
          cursorSdk: async () => ({
            installed: false,
            auth: "unknown" as const,
            loginHint: "unused",
          }),
          antigravity: async () => ({
            installed: false,
            auth: "unknown" as const,
            loginHint: "unused",
          }),
        },
        modelDiscovery: {
          spawn: () => {
            throw new Error("model discovery must stay idle");
          },
        },
      });
      const first = await startDaemon(options());
      let workspaceId: WorkspaceId | undefined;
      let expectedWorkspace: unknown;
      let token: string | undefined;
      let hostId: string | undefined;
      try {
        const origin = await readFile(join(home, "daemon-endpoint"), "utf8");
        token = await readFile(join(home, "daemon-token"), "utf8");
        hostId = await readFile(join(home, "host-id"), "utf8");
        expect(await accessRequest(origin, "/v1/status", { token })).toMatchObject({
          running: true,
          ready: true,
        });
        workspaceId = first.store.createWorkspace(workspaceRoot, "Win workspace");
        expectedWorkspace = first.store.getWorkspace(workspaceId);
      } finally {
        await first.close();
      }
      if (workspaceId === undefined || token === undefined || hostId === undefined)
        throw new Error("Missing first-boot public files");
      const second = await startDaemon(options());
      try {
        const nextOrigin = await readFile(join(home, "daemon-endpoint"), "utf8");
        const nextToken = await readFile(join(home, "daemon-token"), "utf8");
        const nextHostId = await readFile(join(home, "host-id"), "utf8");
        expect(nextToken).toBe(token);
        expect(nextHostId).toBe(hostId);
        expect(await accessRequest(nextOrigin, "/v1/status", { token: nextToken })).toMatchObject({
          running: true,
          ready: true,
        });
        expect(second.store.getWorkspace(workspaceId)).toEqual(expectedWorkspace);
      } finally {
        await second.close();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  },
);
