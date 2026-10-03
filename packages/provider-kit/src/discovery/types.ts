import type { AuthStatus } from "./parsers.ts";
export type DiscoveryResult = AuthStatus & {
  installed: boolean;
  path?: string;
  version?: string;
  loginHint: string;
  error?: string;
};
