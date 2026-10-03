import type { AccessOptions, DeviceTransport } from "@ace/client";
import { createContext, useContext } from "react";
import type { DaemonTarget } from "./connection-settings.ts";

/**
 * How features reach the daemon outside the client's socket: its HTTP access routes and the
 * dedicated devices channel. A real daemon is reached at its target; the fake daemon serves
 * both in memory. Features build their clients from this in their own lazy chunks.
 */
export type DaemonEndpoint =
  | { kind: "daemon"; target: DaemonTarget }
  | { kind: "fake"; access: AccessOptions; devices(): DeviceTransport };

/** Which daemon this window talks to, and how to change it. Provided by the ConnectionGate. */
export interface DaemonConnection {
  mode: "daemon" | "fake";
  url: string;
  remembered: boolean;
  /** Switch to another daemon or token; the client is replaced. */
  connect(target: DaemonTarget, remember: boolean): void;
  /** Forget the token and return to the connection screen. */
  disconnect(): void;
  /** Absent only before a daemon is chosen. */
  endpoint?: DaemonEndpoint | undefined;
}

const fallback: DaemonConnection = {
  mode: "fake",
  url: "memory://fake-daemon",
  remembered: false,
  connect: () => {},
  disconnect: () => {},
};

export const DaemonConnectionContext = createContext<DaemonConnection>(fallback);

export function useDaemonConnection(): DaemonConnection {
  return useContext(DaemonConnectionContext);
}

/** What the fake daemon serves beside its socket (`FakeDaemon` from @ace/fake-daemon). */
export interface FakeSideServices {
  access: { token: string; fetch: AccessOptions["fetch"] };
  appDevices: { transport(): DeviceTransport };
}

/** The connection dev:fake and tests run on: the fake daemon's access routes and devices. */
export function fakeConnection(daemon: FakeSideServices): DaemonConnection {
  return {
    ...fallback,
    endpoint: {
      kind: "fake",
      access: {
        origin: "http://127.0.0.1:4242/",
        fetch: daemon.access.fetch,
        token: async () => daemon.access.token,
      },
      devices: () => daemon.appDevices.transport(),
    },
  };
}
