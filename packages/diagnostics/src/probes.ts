import { constants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import {
  discoverProviders,
  discoverAntigravity,
  findExecutable,
} from "@ace/provider-kit/discovery";
import { probeOutput } from "@ace/provider-kit/process";
import type { DoctorProbes } from "./doctor.ts";
import { checkIntegrity } from "./sqlite.ts";
export function portAvailable(port: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  const server = createServer();
  return new Promise((resolve) => {
    const finish = (available: boolean) => {
      signal.removeEventListener("abort", abort);
      server.close();
      resolve(available);
    };
    const abort = () => finish(false);
    signal.addEventListener("abort", abort, { once: true });
    server.once("error", () => finish(false));
    server.listen(port, "127.0.0.1", () => server.close(() => finish(true)));
  });
}
export function createSystemProbes(options: {
  dataDir: string;
  port: number;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Module origin in the daemon installation, independent of the invoking cwd. */
  moduleOrigin?: URL;
}): DoctorProbes {
  const timeoutMs = options.timeoutMs ?? 4000;
  let discovery: ReturnType<typeof discoverProviders> | undefined;
  return {
    node: async () => process.version,
    provider: async (provider, signal) => {
      discovery ??= discoverProviders({ env: options.env, timeoutMs, signal });
      return (await discovery)[provider];
    },
    antigravity: (signal) => discoverAntigravity({ env: options.env, timeoutMs, signal }),
    git: async (signal) => {
      const git = await findExecutable("git", options.env);
      if (!git) return undefined;
      const result = await probeOutput(git, ["--version"], { timeoutMs, env: options.env, signal });
      return result.code === 0 && /^git version [\w.+-]+$/.test(result.stdout)
        ? result.stdout
        : undefined;
    },
    pty: async (signal) => {
      const source = `const {createRequire}=await import("node:module");const require=createRequire(${JSON.stringify((options.moduleOrigin ?? import.meta.url).toString())});const pty=require("node-pty");if(typeof pty.spawn!=="function")process.exit(1)`;
      return (
        (
          await probeOutput(process.execPath, ["--input-type=module", "-e", source], {
            timeoutMs,
            env: options.env,
            signal,
          })
        ).code === 0
      );
    },
    chromium: async () => {
      const candidates = [
        options.env.ACE_CHROMIUM,
        "chromium",
        "chromium-browser",
        "google-chrome",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
      for (const name of candidates) {
        if (name) {
          const path = await findExecutable(name, options.env);
          if (path) return path;
        }
      }
      return undefined;
    },
    disk: async () => {
      let directory = options.dataDir;
      for (;;) {
        try {
          const fs = await statfs(directory);
          let writable = true;
          try {
            await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
          } catch {
            writable = false;
          }
          return { writable, freeBytes: fs.bavail * fs.bsize };
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          const parent = dirname(directory);
          if (parent === directory) throw new Error("Cannot inspect disk", { cause: error });
          directory = parent;
        }
      }
    },
    integrity: (signal) => checkIntegrity(join(options.dataDir, "events.sqlite"), signal),
    port: (signal) => portAvailable(options.port, signal),
  };
}
