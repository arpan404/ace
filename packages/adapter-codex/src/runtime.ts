import { randomUUID } from "node:crypto";
import { discoverProviders } from "@ace/provider-kit/discovery";
import { spawnSupervised } from "@ace/provider-kit/process";
/** I/O defaults live at the adapter boundary; tests can replace each source independently. */
export type CodexRuntime = {
  now(): number;
  userMessageId(): string;
  spawn: typeof spawnSupervised;
  discover: typeof discoverProviders;
  schedule(callback: () => void, delayMs: number): () => void;
};
export const runtime: CodexRuntime = {
  now: () => performance.now(),
  userMessageId: randomUUID,
  spawn: spawnSupervised,
  discover: discoverProviders,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};
