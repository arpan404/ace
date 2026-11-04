import {
  isDirect,
  relayRoute,
  type ClientApi,
  type Credential,
  type MachineCodeGate,
  type MachineRoute,
  type PathRoute,
  type PortableSocket,
  type Scheduler,
  type Transport,
} from "@ace/client";
import { MachineEntry } from "@ace/client/machines";
import type { MachineCodeRefusal, MachinePath } from "@ace/protocol";

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
   * A direct path (the same computer, the LAN, Tailscale) this app can reach with the
   * machine's identity checked (ADR 0114), carrying `credential`; undefined when it can't check
   * it (a browser can't pin a self-signed certificate). Relays are always usable: their host
   * key is pinned in the handshake.
   */
  directRoute?(
    path: Extract<MachinePath, { kind: "loopback" | "lan" | "tailscale" }>,
    credential: () => Promise<Credential>,
  ): (PathRoute & { probe?(): Promise<number> }) | undefined;
  /**
   * The machine's client, in this thread: `new Client({ deviceId, transport, credential, … })`
   * with the route given. Its outbox and storage are the app's to choose, keyed by `hostId`.
   */
  client(route: {
    hostId: string;
    deviceId: string;
    /**
     * The daemon this machine's connections reached before, first over a relay that pinned
     * its host key: a welcome from any other daemon fails the connection (`expectedHostId`).
     */
    expectedHostId?: string;
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

/**
 * Every path to an account machine this app can use (ADR 0114): ace's relay always, then what
 * the machine said over a verified connection. Relays pin the machine's relay host key; a
 * direct path is used only when the app can check the machine's certificate (`directRoute`).
 * All carry the same device grant (and machine code), so access is the same on every path.
 */
export function accountRoutes(input: {
  relayUrl: string;
  hostId: string;
  account: AccountMachineOptions;
  gate: MachineCodeGate;
  scheduler: Scheduler;
  paths(): readonly MachinePath[];
}): () => MachineRoute[] {
  const { account, gate, hostId } = input;
  const credential = () => gate.credential();
  const relay = (url: string, kind: "relay" | "account"): MachineRoute => ({
    path: { key: `${kind} ${url}`, kind },
    ...relayRoute({
      relayUrl: url,
      hostId,
      credential,
      socket: account.socket,
      schedule: (callback, delayMs) => input.scheduler.set(delayMs, callback),
      refused: (reason, _message, lockedUntil) => gate.refused(reason, lockedUntil),
      welcomed: () => gate.welcomed(),
    }),
  });
  const home = relay(input.relayUrl, "account");
  // Built once per path: a relay route keeps the credential of the attempt it opened.
  const built = new Map<string, MachineRoute>([[home.path.key, home]]);
  return () => {
    const usable = [home];
    for (const path of input.paths()) {
      const key = `${path.kind} ${path.url}`;
      let route = built.get(key);
      if (!route) {
        if (isDirect(path.kind) && "fingerprint" in path) {
          const direct = account.directRoute?.(path, credential);
          route = direct && { path: { key, kind: path.kind }, ...direct };
        } else if ("relayHostId" in path && path.relayHostId === hostId)
          route = relay(path.url, path.kind === "account" ? "account" : "relay");
        if (route) built.set(key, route);
      }
      if (route && !usable.includes(route)) usable.push(route);
    }
    return usable;
  };
}
