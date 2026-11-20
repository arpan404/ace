import { socksReply, type SocksReplyCode } from "./socks5.ts";

/*
 * Why a device tab's connection to the machine's localhost failed, in terms a person can act
 * on (ADR 0194). Pure. Chromium only says "the proxy failed", so the proxy keeps each port's
 * last failure and the tab names it when its load fails.
 */

/**
 * - `off`: the machine's "Pages on this device" setting is off;
 * - `forbidden`: this device may not reach the machine's localhost (read-only);
 * - `refused`: the port is one of ace's own;
 * - `limit`: too many connections at once;
 * - `offline`: the machine can't be reached now;
 * - `closed`: nothing listens on that port on the machine;
 * - `failed`: anything else.
 */
export type TunnelFailure =
  | "off"
  | "forbidden"
  | "refused"
  | "limit"
  | "offline"
  | "closed"
  | "failed";

const byCode: Readonly<Record<string, TunnelFailure>> = {
  tunnel_off: "off",
  tunnel_forbidden: "forbidden",
  tunnel_port_refused: "refused",
  tunnel_limit: "limit",
  // The machine reset the stream before READY: nothing listens on the port.
  tunnel_reset: "closed",
  offline: "offline",
  auth: "forbidden",
};

/** A rejected `MachineTunnel.open`, by its `ClientError` code. */
export function tunnelFailure(error: unknown): TunnelFailure {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  return (typeof code === "string" && byCode[code]) || "failed";
}

/** The SOCKS5 reply Chromium gets for a failure before the stream opened. */
export function failureReply(failure: TunnelFailure): SocksReplyCode {
  if (failure === "off" || failure === "forbidden" || failure === "refused")
    return socksReply.notAllowed;
  if (failure === "offline") return socksReply.networkUnreachable;
  if (failure === "closed") return socksReply.connectionRefused;
  return socksReply.generalFailure;
}

/** How long a port's failure explains a failed load. */
export const failureMemoryMs = 15_000;

/** Each port's last failure on one machine, for the device tab whose load then fails. */
export class TunnelFailures {
  private last = new Map<number, { failure: TunnelFailure; at: number }>();
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }
  record(port: number, failure: TunnelFailure): void {
    this.last.delete(port);
    this.last.set(port, { failure, at: this.now() });
    // A handful of ports at most matter; keep the newest few.
    if (this.last.size > 64) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
  }
  /** A connection to the port went through: an older failure no longer explains anything. */
  clear(port: number): void {
    this.last.delete(port);
  }
  /** The port's failure, if it happened within `failureMemoryMs`. */
  recent(port: number): TunnelFailure | undefined {
    const entry = this.last.get(port);
    if (!entry) return undefined;
    return this.now() - entry.at <= failureMemoryMs ? entry.failure : undefined;
  }
}

/** The port a URL connects to: its own, else its scheme's. */
export function urlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" || parsed.protocol === "wss:" ? 443 : 80;
  } catch {
    return undefined;
  }
}

/**
 * A device tab's failed load, with the machine's reason when the load went to the machine's
 * loopback and the tunnel recorded one for that port. A load the person stopped (`ERR_ABORTED`)
 * is no failure.
 */
export function loadFailure(
  load: { url: string; code: number; description: string; loopback: boolean },
  recent: (port: number) => TunnelFailure | undefined,
):
  | { url: string; code: number; description: string; tunnel?: TunnelFailure; port?: number }
  | undefined {
  if (load.code === -3) return undefined;
  const base = { url: load.url, code: load.code, description: load.description };
  if (!load.loopback) return base;
  const port = urlPort(load.url);
  const tunnel = port === undefined ? undefined : recent(port);
  return {
    ...base,
    ...(port === undefined ? {} : { port }),
    ...(tunnel ? { tunnel } : {}),
  };
}
