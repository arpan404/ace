import type { MachineToolResult } from "@ace/protocol";
import type { GuestSession } from "./guest-sessions.ts";

/** The capabilities served through a guest session by a host other than the browser. */
export type HostedCapability = "devices" | "screen" | "commands";

/**
 * How this machine serves one capability to agents from other machines (ADR 0105). The target
 * has already checked the grant; `call` runs inside `GuestSessions.run`, so it is shown, can be
 * stopped, and its signal fires when the person stops it or turns the capability down.
 */
export interface CapabilityHost {
  /** Whether this machine can serve it now (a simulator runtime, a screen to use). */
  available(): boolean;
  /** Whether one call only reads. Unknown tools must answer false: they act. */
  readOnly(tool: string, args: Record<string, unknown>): boolean;
  /** Absent while this build lists the capability but doesn't serve it: `not_supported`. */
  call?(
    session: GuestSession,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<MachineToolResult>;
}

/** A capability this machine has but doesn't serve to other machines yet (stage 2 adds it). */
export function unservedHost(available: () => boolean): CapabilityHost {
  return { available, readOnly: () => false };
}
