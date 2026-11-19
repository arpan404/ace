import type { ConnectionStatus } from "@/boot/connection.tsx";

/**
 * What the connection gate shows: the app for a machine, the startup screen while one answers,
 * the connection screen, or the app with no machine at all.
 */
export type GateView = "app" | "starting" | "splash" | "connect" | "no-machine";

export interface GateFacts {
  /** A client is installed and the host it opens for is known. */
  opened: boolean;
  status: ConnectionStatus;
  /** A target is chosen (stored, handed over, or connected to just now). */
  hasTarget: boolean;
  /** The person asked for the address form. */
  editing: boolean;
  /** A `#token=` link waits for the person to agree. */
  handoff: boolean;
  /** The window was opened by a pairing link, which the connection screen redeems. */
  pairingLink: boolean;
  /** The connection screen is already on screen (or will be: nothing connects behind the splash). */
  shown: boolean;
  /** Inside the desktop app. */
  desktop: boolean;
  /** The desktop app handed over its own daemon. */
  handed: boolean;
  /** This build can open the app with no machine (the gate was given one). */
  canRunEmpty: boolean;
}

/**
 * The window has no machine: nothing chosen, nothing refused, no link waiting and no form asked
 * for. Only then may the app open empty; any problem with a machine is said on the connection
 * screen, never hidden behind an empty app.
 */
export function hasNoMachine(facts: GateFacts): boolean {
  return (
    !facts.hasTarget &&
    !facts.editing &&
    !facts.handoff &&
    !facts.pairingLink &&
    facts.status.kind === "editing" &&
    facts.status.problem === undefined
  );
}

/** Which screen the gate shows for these facts. Pure. */
export function gateView(facts: GateFacts): GateView {
  if (facts.opened) return "app";
  if (facts.status.kind === "starting") return "starting";
  // Connecting behind the startup screen: the daemon answers or doesn't. The desktop's own
  // daemon reconnecting at boot stays there too; a daemon of another version is said on the
  // connection screen instead, since waiting won't fix it.
  const { status } = facts;
  if (
    !facts.shown &&
    (status.kind === "connecting" ||
      (status.kind === "unreachable" && !status.mismatch && facts.desktop && facts.handed))
  )
    return "splash";
  if (facts.canRunEmpty && hasNoMachine(facts)) return "no-machine";
  return "connect";
}
