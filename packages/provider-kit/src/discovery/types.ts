import type { CliVersionCheck } from "@ace/protocol";
import type { AuthStatus } from "./parsers.ts";
export type DiscoveryResult = AuthStatus & {
  installed: boolean;
  path?: string;
  version?: string;
  /** The installed version against ace's minimum, once the CLI is found. */
  versionCheck?: CliVersionCheck;
  loginHint: string;
  error?: string;
};
