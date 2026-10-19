import { z } from "zod";
import type { SupervisedProcess, spawnSupervised } from "@ace/provider-kit/process";
import { loopback } from "./boundaries.ts";

/** OpenCode's own v2 server on a private loopback port, answering only to `password`. */
export function spawnOwnedServer(options: {
  spawn: typeof spawnSupervised;
  command: string;
  env: NodeJS.ProcessEnv | undefined;
  password: string;
  cwd?: string;
}): SupervisedProcess {
  return options.spawn({
    command: options.command,
    args: ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
    env: {
      ...options.env,
      OPENCODE_PASSWORD: options.password,
      OPENCODE_SERVER_PASSWORD: undefined,
      OPENCODE_SERVER_USERNAME: undefined,
    },
    ...(options.cwd ? { cwd: options.cwd } : {}),
    name: "opencode-server",
    maxLineBytes: 65536,
  });
}

export function basicAuthorization(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

/**
 * The loopback URL the server announces once it listens. Only that JSON line is read: other
 * output may hold configuration secrets.
 */
export function ownedServerReady(proc: SupervisedProcess, signal: AbortSignal): Promise<URL> {
  return new Promise<URL>((resolve, reject) => {
    const cleanup = () => {
      proc.stdout.off("line", line);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("OpenCode startup cancelled or process exited"));
    };
    const line = (text: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      const readiness = z.object({ url: z.string() }).safeParse(parsed);
      if (!readiness.success) return;
      cleanup();
      try {
        resolve(loopback(readiness.data.url));
      } catch {
        reject(new Error("Invalid OpenCode readiness URL"));
      }
    };
    proc.stdout.on("line", line);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
