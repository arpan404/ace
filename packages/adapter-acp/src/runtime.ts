import type { CompatibilityProfile } from "@ace/agent-registry";
import type { spawnSupervised } from "@ace/provider-kit/process";
export interface LaunchOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  profile?: CompatibilityProfile;
  version?: string;
}
export interface SessionRuntime {
  spawn: typeof spawnSupervised;
  now(): number;
  schedule?(delay: number, run: () => void): () => void;
}
