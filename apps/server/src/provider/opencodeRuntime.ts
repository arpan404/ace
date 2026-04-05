/**
 * Spawns and caches a local OpenCode HTTP server (`opencode serve`) for SDK access.
 *
 * @module opencodeRuntime
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const DEFAULT_HOST = "127.0.0.1";
const START_TIMEOUT_MS = 12_000;

export type OpenCodeServerHandle = {
  readonly url: string;
  readonly close: () => void;
  readonly binaryPath: string;
};

let cached: OpenCodeServerHandle | null = null;

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

function stopProcess(child: ReturnType<typeof spawn>): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

/**
 * Start `opencode serve` and wait until the server prints its listening URL (same contract as `@opencode-ai/sdk` server bootstrap).
 */
export async function startOpenCodeServer(binaryPath: string): Promise<{
  readonly url: string;
  readonly close: () => void;
}> {
  const port = await getFreePort();
  const args = ["serve", `--hostname=${DEFAULT_HOST}`, `--port=${String(port)}`];
  const child = spawn(binaryPath, args, {
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => {
      stopProcess(child);
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
    close: () => {
      stopProcess(child);
    },
  };
}

/**
 * Returns a shared server handle for the given binary path, restarting when the path changes.
 */
export async function ensureOpenCodeServer(binaryPath: string): Promise<OpenCodeServerHandle> {
  if (cached && cached.binaryPath === binaryPath) {
    return cached;
  }
  if (cached) {
    cached.close();
    cached = null;
  }
  const started = await startOpenCodeServer(binaryPath);
  cached = { ...started, binaryPath };
  return cached;
}

export function resetOpenCodeServerForTests(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}
