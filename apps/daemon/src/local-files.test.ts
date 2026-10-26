import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { afterEach, expect, test } from "vitest";
import type { WorkspaceId } from "@ace/protocol";
import { accessRequest } from "./client-access.ts";
import { readConfig, startDaemon, stubHandler } from "./index.ts";
import { acquireLock } from "./local-files.ts";
import { loadHostId, loadToken } from "./local-files.ts";

const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ace-data-dir-"));
  roots.push(path);
  return path;
}

test.skipIf(process.platform === "win32")(
  "an existing data directory other users can enter is restricted to its owner before locking",
  () => {
    const dataDir = join(root(), ".ace");
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    const release = acquireLock(dataDir);
    try {
      expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    } finally {
      release();
    }
  },
);

test.skipIf(process.platform === "win32")("a symlinked data directory is refused", () => {
  const base = root();
  const target = join(base, "elsewhere");
  mkdirSync(target, { mode: 0o700 });
  const dataDir = join(base, ".ace");
  symlinkSync(target, dataDir);
  expect(() => acquireLock(dataDir)).toThrow("symbolic link");
});

test.runIf(process.platform === "win32")("Windows refuses a junction as the data directory", () => {
  const base = root();
  const target = join(base, "elsewhere");
  mkdirSync(target);
  const dataDir = join(base, ".ace");
  symlinkSync(target, dataDir, "junction");
  expect(() => acquireLock(dataDir)).toThrow("symbolic link");
});

test.runIf(process.platform === "win32")(
  "Windows holds one daemon lock and keeps its token and host id across loads",
  () => {
    const dataDir = join(root(), ".ace");
    const release = acquireLock(dataDir);
    try {
      expect(() => acquireLock(dataDir)).toThrow("Another daemon owns it");
      const token = loadToken(dataDir);
      const host = loadHostId(dataDir);
      expect(token.token).toMatch(/^[0-9a-f]{64}$/);
      expect(loadToken(dataDir)).toEqual(token);
      expect(loadHostId(dataDir)).toBe(host);
    } finally {
      release();
    }
    acquireLock(dataDir)();
  },
);

test.runIf(process.platform === "win32")(
  "a Windows daemon cold boot shuts down cleanly then restarts from the same home",
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
