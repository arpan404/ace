import { createContext, useContext } from "react";
import type { DaemonTarget } from "./connection-settings.ts";

/** Which daemon this window talks to, and how to change it. Provided by the ConnectionGate. */
export interface DaemonConnection {
  mode: "daemon" | "fake";
  url: string;
  remembered: boolean;
  /** Switch to another daemon or token; the client is replaced. */
  connect(target: DaemonTarget, remember: boolean): void;
  /** Forget the token and return to the connection screen. */
  disconnect(): void;
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
