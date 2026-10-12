import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DaemonHealth } from "@ace/protocol";
import { secureDataDir } from "../local-files.ts";
import { accessRequest } from "../client-access.ts";
import { hostConnection } from "./connection.ts";
import { timeoutMs, type Args } from "./args.ts";
import { CliFailure } from "./output.ts";
const StartupHealth = DaemonHealth.extend({ ready: z.boolean().optional() });

export interface OpenRuntime {
  platform: NodeJS.Platform;
  now(): number;
  delay(ms: number): Promise<void>;
  connection: typeof hostConnection;
  request: typeof accessRequest;
  start(home: string): void;
  open(command: string, args: string[]): Promise<{ code: number | null }>;
}
export function systemOpenRuntime(): OpenRuntime {
  return {
    platform: process.platform,
    now: () => performance.now(),
    delay,
    connection: hostConnection,
    request: accessRequest,
    start(home) {
      secureDataDir(home);
      const entry = z.string().min(1).parse(process.argv[1]);
      const log = openSync(join(home, "daemon-start.log"), "a", 0o600);
      try {
        // The daemon outlives this launcher and owns its own lock and process inventory.
        const child = spawn(process.execPath, [entry, "serve", "--json"], {
          env: { ...process.env, ACE_HOME: home },
          detached: true,
          stdio: ["ignore", log, log],
        });
        child.once("error", () => {});
        child.unref();
      } finally {
        closeSync(log);
      }
    },
    open: (command, args) =>
      new Promise((resolve, reject) => {
        // GUI applications launched by the OS opener belong to the user after dispatch.
        const child = spawn(command, args, { stdio: "ignore" });
        const timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("GUI launch timed out"));
        }, 10000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code });
        });
      }),
  };
}
export async function ensureDaemon(home: string, args: Args, runtime: OpenRuntime): Promise<void> {
  const deadline = runtime.now() + timeoutMs(args);
  let started = false;
  while (runtime.now() < deadline) {
    try {
      const connection = runtime.connection(home);
      const health = StartupHealth.parse(
        await runtime.request(connection.origin, "/v1/status", { token: connection.token }),
      );
      if (health.ready !== false) return;
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          ["ENOENT", "ECONNREFUSED"].includes(String(error.code))
        )
      )
        throw error;
      if (!started) {
        runtime.start(home);
        started = true;
      }
    }
    await runtime.delay(200);
  }
  throw new CliFailure(
    "timeout",
    "Daemon startup is unconfirmed. See daemon-start.log in ACE_HOME.",
  );
}
export function opener(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "linux") return { command: "xdg-open", args: [target] };
  throw new CliFailure("needs-human", `Open ${target} in ace or your browser`);
}
