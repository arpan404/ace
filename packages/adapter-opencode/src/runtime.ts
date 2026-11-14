import { randomBytes } from "node:crypto";
import { discoverProvider, discoverProviders } from "@ace/provider-kit/discovery";
import { spawnSupervised } from "@ace/provider-kit/process";
import type { LaunchedTree } from "./launched-tree.ts";
import { installationIdentity } from "./installation.ts";
export type Runtime = {
  wallTime(): number;
  monotonic(): number;
  entropy(bytes: number): string;
  discover: typeof discoverProviders;
  discoverProvider: typeof discoverProvider;
  spawn: typeof spawnSupervised;
  fetch: typeof fetch;
  schedule(callback: () => void, delayMs: number): () => void;
  /** The file an OpenCode path runs right now; see installation.ts. */
  installationIdentity(path: string): Promise<string | undefined>;
  /** Host platform; tests inject "win32" to cover the Windows launch path. */
  platform?: NodeJS.Platform;
  /** Windows only: ties a shimmed server's pid to the tree ace launched. Loaded on demand. */
  launchedTree?: LaunchedTree;
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
    installationIdentity,
    ...overrides,
  };
}
