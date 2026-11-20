import type { CompatibilityProfile, ProfileFit } from "@ace/agent-registry";
import type { spawnSupervised } from "@ace/provider-kit/process";
export interface LaunchOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  profile?: CompatibilityProfile;
  /** How the profile covers the approved version, as the registry recorded it. */
  profileFit?: ProfileFit;
  version?: string;
  /** The method the person signed in with, selected again if the agent asks for one. */
  signInMethod?: string;
}
export interface SessionRuntime {
  spawn: typeof spawnSupervised;
  now(): number;
  schedule?(delay: number, run: () => void): () => void;
  /** Host platform; tests inject "win32" to cover the Windows stop path. */
  platform?: NodeJS.Platform;
}
