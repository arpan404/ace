import type { MachineCodeGate } from "@ace/client";
import { createContext, use } from "react";

/** How far opening an account machine got. */
export type AccountMachineState =
  | { kind: "connecting" }
  /** Its daemon wants the machine code: the gate says why. */
  | { kind: "asking"; lockedUntil?: number | undefined }
  /** Welcomed: it is in the machine pool now and lists as a connected machine. */
  | { kind: "open" }
  | { kind: "failed"; message: string };

export interface AccountMachineConnection {
  readonly gate: MachineCodeGate;
  get(): AccountMachineState;
  subscribe(listener: () => void): () => void;
  /** Opens a new channel, sending the code the person entered into the gate. */
  retry(): void;
  close(): void;
}

/**
 * Opens a machine on the person's ace account through ace's relay (ADR 0111): a fresh device
 * grant per channel and `machineCodeGate` for the code.
 *
 * TODO(ace/relay-main-conversation): the real connector needs the client API that opens an
 * account machine's main channel through the hosted relay and adds it to the machine pool
 * (`@ace/client-worker/machines`), reporting `machine_code_*` refusals into a `machineCodeGate`.
 * Until it lands no connector is provided in real builds, so account machines list without
 * Open; the fake mode supplies `fakeAccountConnector`.
 */
export interface AccountMachineConnector {
  connect(hostId: string): AccountMachineConnection;
}

export const AccountMachineConnectorContext = createContext<AccountMachineConnector | undefined>(
  undefined,
);

export function useAccountMachineConnector(): AccountMachineConnector | undefined {
  return use(AccountMachineConnectorContext);
}
