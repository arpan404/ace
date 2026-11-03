import type {
  ClientApi,
  Credential,
  MachineCodeGate,
  PortableSocket,
  Transport,
} from "@ace/client";
import { MachineEntry } from "@ace/client/machines";
import type { MachineCodeRefusal } from "@ace/protocol";

/** A machine the ace account backend lists (`GET /v1/machines`). */
export interface AccountMachine {
  /** Its relay host id: the key the hosted relay routes by and the client pins. */
  hostId: string;
  name: string;
  platform?: string | undefined;
}

/**
 * What the pool needs to open account machines (ADR 0111). The pool builds the relay route and
 * the machine-code gate; the app supplies grants, the socket and the client.
 */
export interface AccountMachineOptions {
  /** ace's hosted relay (`wss://…`), from the app's configuration. */
  relayUrl: string;
  /** This app's device id on the account: the subject of its device grants. */
  deviceId: string;
  /**
   * A fresh five-minute device grant, called once per connection attempt; for example
   * `aceAccountClient(...).grant(session, { kind: "device", subject: deviceId }, signal)`.
   */
  grant(): Promise<string>;
  socket(url: string, protocols?: string[]): PortableSocket;
  /**
   * The machine's client, in this thread: `new Client({ deviceId, transport, credential, … })`
   * with the route given. Its outbox and storage are the app's to choose, keyed by `hostId`.
   */
  client(route: {
    hostId: string;
    deviceId: string;
    transport(): Transport;
    credential(): Promise<Credential>;
  }): ClientApi;
}

/** How far opening an account machine got, for the UI. */
export type AccountMachineState =
  | { kind: "connecting" }
  /** Its daemon wants the machine code; `lockedUntil` while code entry is paused. */
  | { kind: "asking"; reason: MachineCodeRefusal; lockedUntil?: number | undefined }
  /** Welcomed and verified: it is a connected machine in the pool. */
  | { kind: "open" }
  | { kind: "failed"; message: string };

export interface AccountMachineConnection {
  /** Its machine code gate: `asking`, `lockedUntil`, `enter(code)`. */
  readonly gate: MachineCodeGate;
  get(): AccountMachineState;
  subscribe(listener: () => void): () => void;
  /** Connect again now, sending the code entered into the gate (or `enter` below). */
  retry(): void;
  /** Enter the code and connect again; throws when the code is malformed (4–128 chars). */
  enter(code: string): void;
  /** Disconnect and take the machine out of the pool. */
  close(): Promise<void>;
}

export function accountMachineEntry(
  machine: AccountMachine,
  options: Pick<AccountMachineOptions, "relayUrl" | "deviceId">,
): MachineEntry {
  return MachineEntry.parse({
    hostId: machine.hostId,
    displayName: machine.name,
    target: { kind: "account", relayUrl: options.relayUrl },
    deviceId: options.deviceId,
  });
}

/** The UI's reading of a machine's pool state. Pure. */
export function accountMachineState(
  state: { status: string; error?: { message: string } | undefined } | undefined,
  gate: Pick<MachineCodeGate, "asking" | "lockedUntil">,
): AccountMachineState {
  if (!state) return { kind: "failed", message: "This machine is closed." };
  if (state.status === "online") return { kind: "open" };
  if (state.status === "machine_code" && gate.asking)
    return {
      kind: "asking",
      reason: gate.asking,
      ...(gate.lockedUntil === undefined ? {} : { lockedUntil: gate.lockedUntil }),
    };
  if (state.status === "auth_failed")
    return { kind: "failed", message: state.error?.message ?? "Sign in to ace again." };
  // Offline retries by itself; until then it reads as connecting.
  return { kind: "connecting" };
}
