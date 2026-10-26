/*
 * Whether one screen_state or screen_act request runs inside a locked use protected interval.
 * Only when the person turned locked use on, the service reports a verified installation and
 * the Mac is locked does the request go through `runProtected`. While an interval is underway
 * (or may still hold the Mac unlocked) every other request is refused: the desktop it would
 * reach was unlocked by locked use for one attempt, not by the person. Otherwise, including
 * any failure while deciding, the request is sent exactly as it would be without the gate.
 */
import type { LockedUseServiceStatus } from "../locked-use-wire.ts";
import { ComputerError } from "./errors.ts";

export type LockedUseRoute = "protected" | "unchanged";

export interface LockedUseFacts {
  /** The person's `computer.lockedUse` setting. */
  enabled: boolean;
  /** The service's latest status; absent when it isn't running. */
  status: LockedUseServiceStatus | undefined;
}

export function lockedUseRoute(facts: LockedUseFacts): LockedUseRoute {
  return facts.enabled === true &&
    facts.status?.installation.verified === true &&
    facts.status.session === "locked"
    ? "protected"
    : "unchanged";
}

/** The approved turn a protected interval is scoped to: never taken from tool arguments. */
export interface LockedUseTurnScope {
  threadID: string;
  turnID: string;
}

export interface LockedUseGatePorts {
  enabled(): Promise<boolean>;
  /**
   * A protected interval is queued, running, or may still hold the Mac unlocked (relocking,
   * faulted). Read whatever the setting says, so turning it off mid-interval changes nothing.
   */
  intervalActive(): boolean;
  /** A fresh status from the service, starting it if needed. Read only while enabled. */
  status(): Promise<LockedUseServiceStatus | undefined>;
  /** The run (turn) the calling agent is in now, if any. */
  turn(threadId: string, agentId: string): string | undefined;
  /** The computer helper processes that will carry out requests for `app`. */
  agentProcessIDs(app: string): Promise<readonly number[]>;
  runProtected<T>(
    scope: LockedUseTurnScope,
    agentProcessIDs: readonly number[],
    work: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
}

export interface LockedUseCall {
  threadId: string;
  agentId: string;
  /** The app's bundle id. */
  app: string;
  signal: AbortSignal;
}

/** Sends one helper request, either as it is or inside a protected interval. */
export type LockedUseGate = (
  call: LockedUseCall,
  send: (signal: AbortSignal) => Promise<unknown>,
) => Promise<unknown>;

interface Protected {
  scope: LockedUseTurnScope;
  agentProcessIDs: readonly number[];
}

async function decide(ports: LockedUseGatePorts, call: LockedUseCall) {
  const enabled = await ports.enabled();
  if (!enabled) return undefined;
  if (lockedUseRoute({ enabled, status: await ports.status() }) !== "protected") return undefined;
  const turnID = ports.turn(call.threadId, call.agentId);
  if (!turnID) return undefined;
  const agentProcessIDs = await ports.agentProcessIDs(call.app);
  if (!agentProcessIDs.length) return undefined;
  return { scope: { threadID: call.threadId, turnID }, agentProcessIDs } satisfies Protected;
}

/** Fails closed: a port that can't answer counts as an interval underway. */
function intervalActive(ports: LockedUseGatePorts): boolean {
  try {
    return ports.intervalActive();
  } catch {
    return true;
  }
}

export function lockedUseGate(ports: LockedUseGatePorts): LockedUseGate {
  return async (call, send) => {
    let route: Protected | undefined;
    try {
      route = await decide(ports, call);
    } catch {
      route = undefined;
    }
    // Checked after deciding, with nothing awaited before the send below, so an interval
    // can't start between this check and the request reaching the helper's queue.
    if (intervalActive(ports))
      throw new ComputerError(
        "locked_use_interval_active",
        "The Mac is briefly unlocked for another task. Nothing was done; try again in a moment.",
      );
    if (!route) return send(call.signal);
    return ports.runProtected(
      route.scope,
      route.agentProcessIDs,
      (signal) => send(AbortSignal.any([call.signal, signal])),
      call.signal,
    );
  };
}
