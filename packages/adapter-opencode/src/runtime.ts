import { randomBytes } from "node:crypto";
import { discoverProvider, discoverProviders } from "@ace/provider-kit/discovery";
import { spawnSupervised } from "@ace/provider-kit/process";
export type Runtime = {
  wallTime(): number;
  monotonic(): number;
  entropy(bytes: number): string;
  discover: typeof discoverProviders;
  discoverProvider: typeof discoverProvider;
  spawn: typeof spawnSupervised;
  fetch: typeof fetch;
  schedule(callback: () => void, delayMs: number): () => void;
};
/** All nondeterminism enters through this I/O boundary. */
export function runtime(overrides: Partial<Runtime> = {}): Runtime {
  return {
    wallTime: () => Date.now(),
    monotonic: () => performance.now(),
    entropy: (bytes) => randomBytes(bytes).toString("hex"),
    discover: discoverProviders,
    discoverProvider,
    spawn: spawnSupervised,
    fetch: (...args) => fetch(...args),
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
    ...overrides,
  };
}
