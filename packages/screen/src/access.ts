import type { ScreenState } from "@ace/protocol";

/**
 * Daemon-owned persistence of the computer use switch, and the audit sink; screen has no SQLite
 * or engine dependency. Agent calls need no grant: the provider's own permission mode decides.
 */
export interface ScreenAccess {
  enabled(): boolean;
  enable(enabled: boolean): void;
  audit(state: ScreenState, action: string, outcome: string): void;
}
