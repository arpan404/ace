import type { ScreenAgentScope, ScreenGrant, ScreenState } from "@ace/protocol";

/** A mutation remains owned only until another writer replaces its revision. */
export interface ScreenAccessRevision {
  current(): boolean;
}
export interface ScreenDeviceAccess {
  enable(): Promise<void>;
  approve(): Promise<void>;
  commit(): void;
  rollback(): Promise<void>;
}

/** Daemon-owned persistence and host approvals; screen has no SQLite or engine dependency. */
export interface ScreenAccess {
  currentTurn?(threadId: string): string | undefined;
  enabled(): boolean;
  enable(enabled: boolean): ScreenAccessRevision | void;
  list(threadId?: string): ScreenGrant[];
  allows(bundleId: string, scope?: ScreenAgentScope): boolean;
  approve(
    bundleId: string,
    allowed: boolean,
    scope: ScreenGrant["scope"],
    threadId?: string,
  ): ScreenAccessRevision | void;
  request(
    bundleId: string,
    reason: string,
    caller: ScreenAgentScope,
    signal: AbortSignal,
  ): Promise<void>;
  foreground(state: ScreenState, reason: string, signal: AbortSignal): Promise<void>;
  audit(state: ScreenState, action: string, outcome: string): void;
}
