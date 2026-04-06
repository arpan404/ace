/**
 * Spawns a dedicated local OpenCode HTTP server (`opencode serve`) for SDK access.
 *
 * @module opencodeRuntime
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const START_TIMEOUT_MS = 12_000;
const STOP_TIMEOUT_MS = 2_000;
const PARENT_CLEANUP_EVENTS = [
  "beforeExit",
  "disconnect",
  "exit",
  "uncaughtExceptionMonitor",
] as const;
type ParentCleanupEvent = (typeof PARENT_CLEANUP_EVENTS)[number];
type OpenCodeProcessOptions = {
  readonly processGroup?: boolean;
};

export type OpenCodeServerHandle = {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly binaryPath: string;
};

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, DEFAULT_HOST, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export function killChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
  options?: OpenCodeProcessOptions,
): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall back to direct kill when taskkill is unavailable.
    }
  }

  if (options?.processGroup === true && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child when group shutdown is unavailable.
    }
  }

  child.kill(signal);
}

type ParentCleanupProcess = Pick<NodeJS.Process, "platform"> & {
  off(event: ParentCleanupEvent, listener: (...args: Array<unknown>) => void): unknown;
  once(
    event: Exclude<ParentCleanupEvent, "uncaughtExceptionMonitor">,
    listener: (...args: Array<unknown>) => void,
  ): unknown;
  on(event: "uncaughtExceptionMonitor", listener: (...args: Array<unknown>) => void): unknown;
};

export function registerParentProcessCleanup(
  child: ChildProcess,
  processRef: ParentCleanupProcess = process,
  options?: OpenCodeProcessOptions,
): () => void {
  const cleanup = () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    killChildProcess(child, "SIGTERM", options);
  };

  const handlers = new Map<ParentCleanupEvent, (...args: Array<unknown>) => void>();
  for (const event of PARENT_CLEANUP_EVENTS) {
    const handler = () => {
      cleanup();
    };
    handlers.set(event, handler);
    if (event === "uncaughtExceptionMonitor") {
      processRef.on(event, handler);
    } else {
      processRef.once(event, handler);
    }
  }

  const unregister = () => {
    for (const [event, handler] of handlers) {
      processRef.off(event, handler);
    }
    child.off("error", unregister);
    child.off("exit", unregister);
  };

  child.once("error", unregister);
  child.once("exit", unregister);

  return unregister;
}

async function stopProcess(
  child: ReturnType<typeof spawn>,
  options?: OpenCodeProcessOptions,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const finalize = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };

    const onError = (cause: Error) => {
      finalize(() => reject(cause));
    };

    const onExit = () => {
      finalize(() => resolve());
    };

    child.once("error", onError);
    child.once("exit", onExit);

    killChildProcess(child, "SIGTERM", options);
    forceKillTimer = setTimeout(() => {
      killChildProcess(child, "SIGKILL", options);
    }, 1_000);
    timeoutTimer = setTimeout(() => {
      finalize(() => reject(new Error("Timed out stopping OpenCode server process.")));
    }, STOP_TIMEOUT_MS);
  });
}

/**
 * Start `opencode serve` and wait until the server prints its listening URL (same contract as `@opencode-ai/sdk` server bootstrap).
 */
export async function startOpenCodeServer(binaryPath: string): Promise<OpenCodeServerHandle> {
  const port = await getFreePort();
  const args = ["serve", `--hostname=${DEFAULT_HOST}`, `--port=${String(port)}`];
  const processOptions = { processGroup: process.platform !== "win32" } as const;
  const child = spawn(binaryPath, args, {
    detached: processOptions.processGroup,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const unregisterParentCleanup = registerParentProcessCleanup(child, process, processOptions);

  const url = await new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      void stopProcess(child, processOptions);
      reject(
        new Error(
          `Timeout waiting for OpenCode server to start after ${String(START_TIMEOUT_MS)}ms`,
        ),
      );
    }, START_TIMEOUT_MS);
    let output = "";
    let resolved = false;

    const finalizeReject = (err: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(id);
      reject(err);
    };

    const finalizeResolve = (value: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(id);
      resolve(value);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (resolved) return;
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            finalizeReject(new Error(`Failed to parse OpenCode server url from: ${line}`));
            return;
          }
          finalizeResolve(match[1]!);
          return;
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("exit", (code) => {
      finalizeReject(new Error(`OpenCode server exited with code ${String(code)}\n${output}`));
    });

    child.on("error", (err) => {
      finalizeReject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  return {
    url,
    binaryPath,
    close: async () => {
      unregisterParentCleanup();
      await stopProcess(child, processOptions);
    },
  };
}
