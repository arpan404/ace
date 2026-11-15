import {
  EARLY_SIDEBAR_WINDOWS,
  EARLY_THREAD_SUBSCRIBES,
  EarlySubscribe,
  RELAY_NK_HANDSHAKE,
  type HelloConfirm,
  type HelloEarly,
} from "@ace/protocol";
import { fingerprint } from "@ace/secure-channel";

/*
 * What a relay route remembers to open its next stream with Noise NK (ADR 0155, step 2), in
 * memory only: the daemon key it pinned, that a welcome under that key announced NK, the next
 * ticket a welcome handed, and how NK has fared on this host. Pure; the route owns the I/O.
 */

/** The wait before NK is tried again after two failures in a row, doubling to a day. */
export const NK_RETRY_MS = 10 * 60_000;
export const NK_RETRY_MAX_MS = 24 * 60 * 60_000;
/** A ticket is presented only while it has this much life left by both clocks. */
const TICKET_MARGIN_MS = 5_000;

type Ticket = { ticket: string; until: number; wallUntil: number | undefined };

export type NkClocks = { now(): number; wallNow?: (() => number) | undefined };

export class RelayNkMemory {
  readonly #pin: string;
  readonly #clocks: NkClocks;
  #hostKey: Uint8Array | undefined;
  #capable = false;
  #ticket: Ticket | undefined;
  #failures = 0;
  #wait = NK_RETRY_MS;
  #retryAt = 0;

  constructor(pin: string, clocks: NkClocks) {
    this.#pin = pin;
    this.#clocks = clocks;
  }

  /**
   * A welcome arrived on a stream keyed to `hostKey`. It carries the capability only for that
   * key, and only when the key is the pinned one: another key carries nothing, and replaces
   * nothing.
   */
  welcomed(hostKey: Uint8Array | undefined, relayHandshakes: string[] | undefined): void {
    if (!hostKey || fingerprint(hostKey) !== this.#pin) return;
    this.#hostKey = hostKey.slice();
    this.#capable = relayHandshakes?.includes(RELAY_NK_HANDSHAKE) === true;
  }

  /** The next one-use ticket a welcome or a confirmation handed. */
  handed(ticket: { ticket: string; ttlMs: number } | undefined): void {
    if (!ticket) return;
    const wall = this.#clocks.wallNow?.();
    this.#ticket = {
      ticket: ticket.ticket,
      until: this.#clocks.now() + ticket.ttlMs,
      wallUntil: wall === undefined ? undefined : wall + ticket.ttlMs,
    };
  }

  /**
   * The key and ticket for an NK attempt, or undefined for XX: no announcement under the pinned
   * key, nothing to present (no fresh ticket, no grant), or NK resting after failures. A ticket
   * returned is taken: it is one-use.
   */
  attempt(grant: string | undefined): { hostKey: Uint8Array; ticket?: string } | undefined {
    const now = this.#clocks.now();
    if (!this.#capable || !this.#hostKey || now < this.#retryAt) return undefined;
    if (grant !== undefined) return { hostKey: this.#hostKey };
    const ticket = this.#ticket;
    this.#ticket = undefined;
    const wall = this.#clocks.wallNow?.();
    const fresh =
      ticket !== undefined &&
      ticket.until - TICKET_MARGIN_MS > now &&
      (ticket.wallUntil === undefined ||
        wall === undefined ||
        ticket.wallUntil - TICKET_MARGIN_MS > wall);
    return fresh ? { hostKey: this.#hostKey, ticket: ticket.ticket } : undefined;
  }

  /** An NK attempt reached its welcome. */
  succeeded(): void {
    this.#failures = 0;
    this.#wait = NK_RETRY_MS;
    this.#retryAt = 0;
  }

  /** An NK attempt was refused or failed before its welcome. XX attempts change nothing. */
  failed(): void {
    this.#failures++;
    if (this.#failures < 2) return;
    this.#retryAt = this.#clocks.now() + this.#wait;
    this.#wait = Math.min(this.#wait * 2, NK_RETRY_MAX_MS);
  }
}

type HelloFields = {
  deviceId: string;
  token?: string;
  ticket?: string;
  grant?: string;
  machineCode?: string;
  installId?: string;
  link?: HelloConfirm["link"];
  trims?: string[];
  framing?: string[];
  compression?: string[];
  flowControl?: string[];
  channel?: string;
  [key: string]: unknown;
};

/**
 * A connection's first flight (its hello, then any read subscribes) as an NK first payload and
 * its confirmation: the allowlisted fields go early, the device-acting ones in the
 * confirmation, and every other message waits to go after it. Undefined when this hello can't
 * open with NK (a dedicated channel, or a machine code the daemon asked for).
 */
export function earlyFlight(
  flight: string[],
  credential: { ticket?: string; grant?: string },
): { early: HelloEarly; confirm: HelloConfirm; rest: string[] } | undefined {
  const [first, ...others] = flight;
  if (first === undefined) return undefined;
  const hello = JSON.parse(first) as HelloFields;
  if (hello.channel !== undefined || hello.machineCode !== undefined) return undefined;
  const subscribes: EarlySubscribe[] = [];
  const rest: string[] = [];
  let threads = 0;
  let windows = 0;
  for (const text of others) {
    const parsed: unknown = JSON.parse(text);
    const { type, ...fields } = parsed as { type?: string };
    const subscribe = type === "subscribe" ? EarlySubscribe.safeParse(fields) : undefined;
    const scope = subscribe?.success ? subscribe.data.scope : undefined;
    const fits =
      scope?.kind === "thread"
        ? threads < EARLY_THREAD_SUBSCRIBES
        : scope?.kind === "threads" && scope.window !== undefined && windows < EARLY_SIDEBAR_WINDOWS;
    if (subscribe?.success && fits) {
      if (scope?.kind === "thread") threads++;
      else windows++;
      subscribes.push(subscribe.data);
    } else rest.push(text);
  }
  const early: HelloEarly = {
    type: "hello.early",
    protocolVersion: 1,
    deviceId: hello.deviceId as HelloEarly["deviceId"],
    ...(credential.ticket !== undefined ? { ticket: credential.ticket } : {}),
    ...(credential.grant !== undefined ? { grant: credential.grant } : {}),
    ...(hello.trims ? { trims: hello.trims } : {}),
    ...(hello.framing ? { framing: hello.framing } : {}),
    ...(hello.compression ? { compression: hello.compression } : {}),
    ...(hello.flowControl ? { flowControl: hello.flowControl } : {}),
    ...(subscribes.length ? { subscribes } : {}),
  };
  const confirm: HelloConfirm = {
    type: "hello.confirm",
    ...(hello.installId !== undefined
      ? { installId: hello.installId as NonNullable<HelloConfirm["installId"]> }
      : {}),
    ...(hello.link !== undefined && credential.grant !== undefined ? { link: hello.link } : {}),
    ...(credential.ticket !== undefined ? { nextTicket: true as const } : {}),
  };
  return { early, confirm, rest };
}

/** A paired device's XX hello on a relay asks for the next ticket, for its next NK attempt. */
export function askNextTicket(hello: string): string {
  const parsed = JSON.parse(hello) as HelloFields;
  if (parsed.token === undefined || parsed.channel !== undefined) return hello;
  return JSON.stringify({ ...parsed, nextTicket: true });
}
