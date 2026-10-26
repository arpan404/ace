import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorMode } from "@ace/provider-kit/permission-modes";
import { expect, test } from "vitest";
import { createCursorAccountDriver } from "./auth.ts";
import { CursorHost } from "./host.ts";
import { cursorSdkEnvironment } from "./instance.ts";
import { CursorHostSlots } from "./slots.ts";

/*
 * Cursor's real SDK host on Windows x64, with an empty private home and no key: nothing here
 * can sign in or reach Cursor. Status is read from the SDK's own (absent) credential file and
 * model listing stops at "not configured" before any request.
 */
const x64 = process.platform === "win32" && process.arch === "x64";
const launch = (): NodeJS.ProcessEnv => ({ ...process.env, CURSOR_API_KEY: undefined });

async function privateHome(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "ace-cursor-host-")));
}

test.runIf(x64)(
  "a Windows SDK host with no credentials reports signed out and no models",
  async () => {
    const home = await privateHome();
    const driver = createCursorAccountDriver({
      launchEnv: launch(),
      slots: new CursorHostSlots(2),
      stopInstance: async () => {},
    });
    const instance = { id: "windows", homeDir: home };
    try {
      const signal = AbortSignal.timeout(60_000);
      expect(await driver.status(instance, signal)).toEqual({
        status: "logged-out",
        source: "none",
      });
      await expect(driver.models(instance, signal)).rejects.toMatchObject({
        code: "not_configured",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.runIf(x64)(
  "a Windows SDK host ends itself cleanly when ace's side of its pipe closes",
  async () => {
    const home = await privateHome();
    const host = new CursorHost(
      {
        env: cursorSdkEnvironment({ id: "windows", homeDir: home }, launch()),
        // A long grace: only the host's own exit can end it before ace's forced tree stop.
        limits: { graceMs: 30_000 },
      },
      () => {},
    );
    try {
      expect(await host.request("status")).toEqual({ status: "logged-out", source: "none" });
      const started = performance.now();
      host.process.stdin.end();
      const exit = await host.process.exited;
      expect(exit).toMatchObject({ code: 0, reason: "exit" });
      expect(performance.now() - started).toBeLessThan(20_000);
      // No uncaught error on the way out: the POSIX group kill is never attempted.
      expect(host.failureMessage).toBeUndefined();
      const pid = host.process.pid;
      expect(pid).toBeDefined();
      expect(() => process.kill(pid ?? 0, 0)).toThrow();
    } finally {
      await host.stop();
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.runIf(x64)(
  "Auto review is refused on Windows before any Cursor agent starts, naming what still works",
  async () => {
    const sdk = await import("@cursor/sdk");
    const { HostRuntime, CursorLimitsSchema } = await import("./index.ts");
    const home = await privateHome();
    const started: string[] = [];
    const errors: string[] = [];
    const host = new HostRuntime(
      {
        ...sdk,
        sandboxSupport: async () => {
          started.push("sandbox probe");
          return { supported: true, release: async () => {} };
        },
        Cursor: { auth: { status: async () => ({ status: "logged-in", backendUrl: "x" }) } },
        Agent: {
          create: async () => {
            started.push("agent");
            throw new Error("No agent starts in a refused mode");
          },
          resume: async () => {
            throw new Error("Unexpected resume");
          },
          cancelRun: async () => {},
        },
      },
      async (frame) => {
        if (frame.kind === "error") errors.push(JSON.stringify(frame.body));
      },
      () => home,
      {},
    );
    try {
      await expect(
        host.open({
          threadId: "refused",
          generation: "host",
          cwd: home,
          permissionMode: cursorMode(true, true),
          limits: CursorLimitsSchema.parse({}),
        }),
      ).rejects.toThrow("SDK setup failed");
      expect(started).toEqual([]);
      expect(errors.join("\n")).toContain(
        "Cursor's SDK has no file sandbox on Windows (its helper only filters network traffic), so Cursor can't run in Auto review, its sandboxed mode, on this machine. Full access still works.",
      );
    } finally {
      await host.close().catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  },
);
