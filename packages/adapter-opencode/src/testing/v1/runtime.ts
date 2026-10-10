import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { discoverLegacyOpenCode } from "./discovery.ts";
import { spawnSupervised } from "@ace/provider-kit/process";
import { readSse } from "@ace/provider-kit/sse";
export type Runtime = {
  wallTime(): number;
  monotonic(): number;
  entropy(bytes: number): string;
  port(): Promise<number>;
  discover: typeof discoverLegacyOpenCode;
  spawn: typeof spawnSupervised;
  fetch: typeof fetch;
  stream: typeof readSse;
  schedule(callback: () => void, delayMs: number): () => void;
};
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot allocate OpenCode port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
/** All nondeterminism enters through this I/O boundary. */
export function runtime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    wallTime: () => Date.now(),
    monotonic: () => performance.now(),
    entropy: (bytes) => randomBytes(bytes).toString("hex"),
    port,
    discover: discoverLegacyOpenCode,
    spawn: spawnSupervised,
    fetch: (...args) => fetch(...args),
    stream: readSse,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    ...overrides,
  };
}
