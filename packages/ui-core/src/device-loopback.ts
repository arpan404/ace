/*
 * A device tab reaching the machine's localhost (ADR 0194). On the phone the app takes the
 * loopback ports itself: while one machine's device tab is in front, the phone listens on that
 * machine's loopback ports, and each connection becomes a tunnel stream to the same port there.
 * This module decides which ports, whether this machine holds them, and the words for what went
 * wrong. Pure.
 */

/** Whether a URL's hostname names the device's loopback: `localhost`, `*.localhost`, 127/8, ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** The port a loopback page connects to, or undefined for any other page. */
export function loopbackPort(url: string): number | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (!isLoopbackHost(parsed.hostname)) return undefined;
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

/** The most ports the phone listens on at once; the pages' own ports are taken first. */
export const maxListenedPorts = 64;

export interface ListenInput {
  /** The machine's loopback ports, as its tunnel reports them (ace's own already left out). */
  machinePorts: readonly number[];
  /** The loopback ports of this machine's device tabs, listened on before discovery finds them. */
  pagePorts: readonly number[];
  /** Ports another app on the phone holds: binding them failed. */
  busy: ReadonlySet<number>;
}

const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65_535;

/** The ports to listen on, ascending: the pages' own first, then the machine's, minus busy ones. */
export function listenPorts(input: ListenInput): number[] {
  const chosen = new Set<number>();
  for (const port of [...input.pagePorts, ...[...input.machinePorts].sort((a, b) => a - b)]) {
    if (chosen.size >= maxListenedPorts) break;
    if (validPort(port) && !input.busy.has(port)) chosen.add(port);
  }
  return [...chosen].sort((a, b) => a - b);
}

/**
 * Whether this machine holds the phone's loopback ports. A listener can't tell which web view
 * connected, so one machine holds them at a time: the one whose device tab came to the front
 * last, until its last device tab closes or another machine's comes to the front.
 */
export interface LoopbackHold {
  readonly tabs: number;
  readonly holding: boolean;
}
export type LoopbackHoldEvent =
  /** One of this machine's device tabs is now in front. */
  | { kind: "front" }
  /** This machine now has `count` device tabs open. */
  | { kind: "tabs"; count: number }
  /** Another machine's device tab came to the front and took the ports. */
  | { kind: "released" };

export const noLoopbackHold: LoopbackHold = { tabs: 0, holding: false };

export function nextLoopbackHold(hold: LoopbackHold, event: LoopbackHoldEvent): LoopbackHold {
  switch (event.kind) {
    case "front":
      return { ...hold, holding: hold.tabs > 0 };
    case "tabs": {
      const tabs = Math.max(0, Math.floor(event.count));
      return { tabs, holding: hold.holding && tabs > 0 };
    }
    case "released":
      return { ...hold, holding: false };
  }
}

/** Why a device tab's connection to the machine's port failed. */
export type LoopbackProblem =
  /** Another app on the phone holds the port. */
  | "busy"
  /** The machine's `remote.machineLocalhost` is off. */
  | "tunnel_off"
  /** This device may only watch the machine. */
  | "tunnel_forbidden"
  /** The port is one of ace's own listeners. */
  | "tunnel_port_refused"
  /** Too many streams at once. */
  | "tunnel_limit"
  /** The machine can't be reached. */
  | "offline"
  /** Nothing listens on the port on the machine. */
  | "nothing";

const problems: readonly LoopbackProblem[] = [
  "busy",
  "tunnel_off",
  "tunnel_forbidden",
  "tunnel_port_refused",
  "tunnel_limit",
  "offline",
  "nothing",
];

/** A tunnel refusal's code as a problem; an unknown code reads as the machine being offline. */
export function loopbackProblemOf(code: string): LoopbackProblem {
  return (problems as readonly string[]).includes(code) ? (code as LoopbackProblem) : "offline";
}

/** One sentence for a page whose port failed. */
export function loopbackProblemWords(problem: LoopbackProblem, port: number): string {
  switch (problem) {
    case "busy":
      return `Another app on this phone is using port ${port}, so this page can't reach the machine on it.`;
    case "tunnel_off":
      return "This machine doesn't let devices open its localhost. Turn it on in the machine's Remote access settings.";
    case "tunnel_forbidden":
      return "This phone can only watch this machine, so it can't open the machine's localhost.";
    case "tunnel_port_refused":
      return `Port ${port} belongs to ace on the machine, so the phone can't open it.`;
    case "tunnel_limit":
      return "Too many connections to the machine at once. Reload the page in a moment.";
    case "offline":
      return "The machine can't be reached right now, so its localhost can't load.";
    case "nothing":
      return `Nothing is running on port ${port} on the machine.`;
  }
}
