import type { ScreenAgentScope, ScreenGrant, ScreenState } from "@ace/protocol";

/** Daemon-owned persistence and host approvals; screen has no SQLite or engine dependency. */
export interface ScreenAccess {
  enabled(): boolean;
  enable(enabled: boolean): void;
  list(threadId?: string): ScreenGrant[];
  allows(bundleId: string, scope?: ScreenAgentScope): boolean;
  approve(bundleId: string, allowed: boolean, scope: ScreenGrant["scope"], threadId?: string): void;
  request(
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
  ): Promise<void>;
  foreground(state: ScreenState, reason: string, signal: AbortSignal): Promise<void>;
  audit(state: ScreenState, action: string, outcome: string): void;
}
