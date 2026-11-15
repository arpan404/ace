/*
 * A machine as a client sees it: whether it answers, and how this client reaches it. The web
 * reads both from its machine pool and the phone from its runtimes; the fleet's words and map
 * are worked out from them.
 */

/**
 * `machine_code`: an account machine waits for its machine code (ADR 0111). `off`: turned off
 * on this device (ADR 0115); listed, never connected.
 */
export type MachineStatus =
  | "online"
  | "connecting"
  | "offline"
  | "auth_failed"
  | "machine_code"
  | "off";

/**
 * How a client reaches a machine, from its saved target: straight to an address (LAN,
 * Tailscale), through a relay, or through ace's relay as an account machine.
 */
export type MachineVia =
  | { kind: "direct"; url: string }
  | { kind: "relay"; url: string }
  | { kind: "account"; url: string };
