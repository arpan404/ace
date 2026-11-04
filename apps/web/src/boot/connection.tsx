import type { AccessOptions, MachineCodeGate } from "@ace/client";
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
  /**
   * A machine on the person's ace account, reached only through ace's hosted relay over the
   * client's own connection: it has no address of its own to dial (`main-machine.ts`).
   */
  | { kind: "account"; hostId: string; deviceId: string }
  | { kind: "fake"; access: AccessOptions; devices(): DeviceTransport; screen(): ScreenTransport };

/**
 * How far this window got with its daemon. The app mounts on the first `ready` and stays
 * mounted; until then the connection screen shows this.
 */
export type ConnectionStatus =
  /** No daemon chosen yet, or the person is editing the address and token. */
  | {
      kind: "editing";
      problem?: ConnectionProblem | undefined;
      /** What the client reported, for the person and for logs; never the token. */
      detail?: string | undefined;
    }
  /** A client is trying the target and hasn't been welcomed yet. */
  | { kind: "connecting" }
  | { kind: "starting" }
  /**
   * The first attempt failed or is taking too long; the client keeps retrying meanwhile.
   * `mismatch`: the daemon answered with what this build can't read.
   */
  | { kind: "unreachable"; offline: boolean; mismatch?: boolean }
  | { kind: "ready" };
/** The daemon sent what this build can't read; the client keeps retrying until they match. */
export const versionMismatchWords =
  "This app and the ace daemon are different versions. Restart ace to update.";
/**
 * Why this window stopped trying; retrying with the same target can't help. Only `auth` means
 * the daemon rejected the token; `identity` means a different daemon than the one this window
 * met at that address answered (its token may be fine); `storage` is this device's own saved
 * data.
 */
export type ConnectionProblem =
  | "auth"
  | "identity"
  | "protocol"
  | "storage"
  | "failed"
  /** An account machine: this window has no ace session. */
  | "signed_out"
  /** An account machine: the ace session ended (the backend refused it). */
  | "session_ended"
  /** An account machine: it left the account, or turned this device away. */
  | "not_on_account"
  /** An account machine: its daemon wants its machine code, or refused the one sent. */
  | "machine_code";

/** Where the app with no machine opens when the person leaves the connection screen. */
export type NoMachinePlace = "/settings/profile" | "/settings/remote";

/** Which daemon this window talks to, and how to change it. Provided by the ConnectionGate. */
export interface DaemonConnection {
  mode: "daemon" | "fake";
  url: string;
  remembered: boolean;
  /** The token of the target being tried or last tried, so a failed attempt keeps it. */
  token?: string | undefined;
  pairedDeviceId?: string | undefined;
  status: ConnectionStatus;
  /** Inside the desktop app: its daemon is managed for the person, never started by hand. */
  desktop?: boolean | undefined;
  pairingLink?: string | undefined;
  /** Switch to another daemon or token; the client is replaced. */
  connect(target: DaemonTarget, remember: boolean): void;
  /** Try the same target again with a fresh client, skipping any backoff. */
  retry(): void;
  /** Stop trying and let the person change the address or token. */
  edit(): void;
  /** Forget the token and return to the connection screen. */
  disconnect(): void;
  /**
   * After an `identity` refusal: forget the daemon this window met at the address before, and
   * the work it saved for it, then connect to the one there now. Absent where nothing can be
   * forgotten (the fake daemon).
   */
  forgetIdentity?: (() => void) | undefined;
  /**
   * Stop trying and go back to the app with no machine, keeping what is stored (a reload tries
   * it again), on `place` if given. Only where the window can run with no machine and doesn't
   * follow the desktop's own daemon.
   */
  leave?: ((place?: NoMachinePlace) => void) | undefined;
  /**
   * The main machine is one on the person's ace account (being opened, refused or open): its
   * name and, once its route has loaded, the machine code gate its daemon asks through.
   * Undefined for any other machine.
   */
  account?: { hostId: string; name: string; code?: MachineCodeGate | undefined } | undefined;
  /**
   * Make a machine on the person's ace account this window's machine, through ace's relay, and
   * keep the choice for a reload. Absent in a build without ace accounts.
   */
  openAccount?: ((machine: { origin: string; hostId: string; name: string }) => void) | undefined;
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
