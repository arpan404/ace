import type { AccessOptions } from "@ace/client";
import type { ScreenTransport } from "@ace/client/screen-stream";
import type { DeviceTransport } from "@ace/client/devices";
import { createContext, useContext } from "react";
import type { DaemonTarget } from "./connection-settings.ts";

/**
 * How features reach the daemon outside the client's socket: its HTTP access routes and the
 * dedicated devices channel. A real daemon is reached at its target; the fake daemon serves
 * both in memory. Features build their clients from this in their own lazy chunks.
 */
export type DaemonEndpoint =
  | { kind: "daemon"; target: DaemonTarget; deviceId: string }
  | { kind: "fake"; access: AccessOptions; devices(): DeviceTransport; screen(): ScreenTransport };

/**
 * How far this window got with its daemon. The app mounts on the first `ready` and stays
 * mounted; until then the connection screen shows this.
 */
export type ConnectionStatus =
  /** No daemon chosen yet, or the person is editing the address and token. */
  | { kind: "editing"; problem?: ConnectionProblem | undefined }
  /** A client is trying the target and hasn't been welcomed yet. */
  | { kind: "connecting" }
  /** The first attempt failed or is taking too long; the client keeps retrying meanwhile. */
  | { kind: "unreachable"; offline: boolean }
  | { kind: "ready" };
/** Why the daemon refused this window; retrying with the same target can't help. */
export type ConnectionProblem = "auth" | "protocol" | "failed";

/** Which daemon this window talks to, and how to change it. Provided by the ConnectionGate. */
export interface DaemonConnection {
  mode: "daemon" | "fake";
  url: string;
  remembered: boolean;
  /** The token of the target being tried or last tried, so a failed attempt keeps it. */
  token?: string | undefined;
  status: ConnectionStatus;
  /** Inside the desktop app: its daemon is managed for the person, never started by hand. */
  desktop?: boolean | undefined;
  /** Switch to another daemon or token; the client is replaced. */
  connect(target: DaemonTarget, remember: boolean): void;
  /** Try the same target again with a fresh client, skipping any backoff. */
  retry(): void;
  /** Stop trying and let the person change the address or token. */
  edit(): void;
  /** Forget the token and return to the connection screen. */
  disconnect(): void;
  /** Absent only before a daemon is chosen. */
  endpoint?: DaemonEndpoint | undefined;
  /** A `#token=` link waiting for the person to agree before anything is saved. */
  handoff?: PendingHandoff | undefined;
}

export interface PendingHandoff {
  url: string;
  /** `elsewhere`: not a daemon on this computer; otherwise it would replace a remembered token. */
  reason: "elsewhere" | "replaces-remembered";
  accept(): void;
  decline(): void;
}

export const fallback: DaemonConnection = {
  mode: "fake",
  url: "memory://fake-daemon",
  remembered: false,
  status: { kind: "ready" },
  connect: () => {},
  retry: () => {},
  edit: () => {},
  disconnect: () => {},
};

export const DaemonConnectionContext = createContext<DaemonConnection>(fallback);

export function useDaemonConnection(): DaemonConnection {
  return useContext(DaemonConnectionContext);
}
