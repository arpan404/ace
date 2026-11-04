import type { ClientApi, ClientError, MachineCodeGate } from "@ace/client";
import * as z from "zod/mini";
import type { ConnectionProblem, DaemonConnection, DaemonEndpoint } from "./connection.tsx";
import type { DaemonTarget } from "./connection-settings.ts";
import { isLoopbackUrl } from "./fragment-handoff.ts";

/*
 * What kind of machine this window's main machine is, in one place. Either one reached at its
 * own address with a token (stored, handed over by the desktop app or paired, perhaps through a
 * self-hosted relay), or one on the person's ace account, reached only through ace's hosted
 * relay with a fresh device grant for every attempt (ADR 0111). Features ask here instead of
 * reading the machine's address.
 */

/**
 * A machine on the person's ace account chosen as this window's machine: all that is kept of
 * it. The grant and the ace session are never part of it.
 */
export const AccountMainMachine = z.object({
  /** The account backend the machine was listed by. */
  origin: z.string().check(z.minLength(1), z.maxLength(2048)),
  /** Its relay host id, the key ace's relay routes by and the client pins. */
  hostId: z.string().check(z.regex(/^[A-Z2-7]{52}$/)),
  name: z.string().check(z.minLength(1), z.maxLength(256)),
});
export type AccountMainMachine = z.infer<typeof AccountMainMachine>;

export type MainMachine =
  | { kind: "address"; target: DaemonTarget }
  | { kind: "account"; machine: AccountMainMachine };

/** Why the account refused an attempt's grant, before any relay was dialled. */
export type GrantProblem = "signed_out" | "session_ended";

/** One account machine's way in: its machine code gate, kept across attempts, and a client per attempt. */
export interface AccountMainRoute {
  readonly code: MachineCodeGate;
  /** This browser's device id on the account. */
  readonly deviceId: string;
  /** A fresh client: each of its attempts asks for its own grant. */
  client(): ClientApi;
  /** Why the last grant was refused, or undefined when it was given (or not asked yet). */
  grantProblem(): GrantProblem | undefined;
}

/**
 * How a window opens a machine on the ace account as its own: its route, or undefined when this
 * build can't (no ace accounts, or the machine was chosen on another account backend). Loaded
 * on demand, so a window with an address machine never fetches the account code.
 */
export type AccountRouteSource = (
  machine: AccountMainMachine,
) => Promise<AccountMainRoute | undefined>;

/**
 * Why an account machine's connection stopped, from what the grant and the client said. Pure.
 * Undefined when it is none of the account's reasons (the usual problems then apply).
 */
export function accountProblem(
  grant: GrantProblem | undefined,
  code: ClientError["code"] | undefined,
): ConnectionProblem | undefined {
  if (grant) return grant;
  if (code === "machine_code") return "machine_code";
  // The relay's "not your machine" (4403) and the daemon turning the grant away both read auth.
  if (code === "auth") return "not_on_account";
  return undefined;
}

/**
 * The address and token this window may dial itself (HTTP routes, a dedicated channel), or
 * undefined: an account machine, or one reached only through a relay, whose address is the
 * relay's and must never get the token.
 */
export function directTarget(endpoint: DaemonEndpoint | undefined): DaemonTarget | undefined {
  return endpoint?.kind === "daemon" && endpoint.target.relayHostId === undefined
    ? endpoint.target
    : undefined;
}

/** The main machine's files are on this computer: a daemon dialled at a loopback address. */
export function onThisComputer(connection: Pick<DaemonConnection, "mode" | "endpoint">): boolean {
  const target = connection.mode === "daemon" ? directTarget(connection.endpoint) : undefined;
  try {
    return target !== undefined && isLoopbackUrl(target.url);
  } catch {
    return false;
  }
}

/** A main machine that dedicated channels (devices, screens) can reach: not an account machine. */
export type ChannelEndpoint = Exclude<DaemonEndpoint, { kind: "account" }>;

/**
 * The endpoint dedicated channels open against, or undefined. A machine on the person's ace
 * account is reached only through its main conversation on ace's relay, so it has none.
 */
export function channelEndpoint(endpoint: DaemonEndpoint | undefined): ChannelEndpoint | undefined {
  return endpoint?.kind === "account" ? undefined : endpoint;
}

/** The main machine is on the person's ace account: it has no channel but the client's. */
export function throughAccount(endpoint: DaemonEndpoint | undefined): boolean {
  return endpoint?.kind === "account";
}

/** This device's id on the main machine: the paired device's, this browser's or its account device's. */
export function endpointDeviceId(endpoint: DaemonEndpoint | undefined): string {
  return endpoint && endpoint.kind !== "fake" ? endpoint.deviceId : "fake";
}

/** What names the main machine in this device's own keys: its account host id, or its address. */
export function machineScope(connection: Pick<DaemonConnection, "url" | "endpoint">): string {
  const endpoint = connection.endpoint;
  return endpoint?.kind === "account" ? `account:${endpoint.hostId}` : connection.url;
}

/** Where the main machine is, for a line of settings: its address's host, or how it is reached. */
export function machineWhere(connection: Pick<DaemonConnection, "url" | "account">): string {
  if (connection.account) return `${connection.account.name} through your ace account`;
  try {
    return new URL(connection.url).host || connection.url;
  } catch {
    return connection.url;
  }
}
