import { z } from "zod";

const Paused = z.object({ requestId: z.string(), request: z.object({ url: z.string() }) });
const Continued = z.object({ requestId: z.string() });

/** Bounds on what the gate remembers per view. */
const maxPending = 1_024;
const maxApproved = 256;

/**
 * WebSockets in an embedded view. The daemon approves origins by intercepting requests with
 * CDP `Fetch`, which never sees WebSocket handshakes. The view must not open a socket the
 * daemon has not approved, so this gate learns approvals from the CDP traffic it relays:
 * a `Fetch.requestPaused` event followed by the daemon's `Fetch.continueRequest` for it.
 * A WebSocket may connect only to the matching origin (`ws` for `http`, `wss` for `https`).
 */
export class WebSocketGate {
  private paused = new Map<string, string>();
  private approved = new Set<string>();

  /** A CDP event from the view, on its way to the daemon. */
  event(method: string, params: unknown): void {
    if (method !== "Fetch.requestPaused") return;
    const parsed = Paused.safeParse(params);
    if (!parsed.success) return;
    if (this.paused.size >= maxPending) {
      const oldest = this.paused.keys().next();
      if (!oldest.done) this.paused.delete(oldest.value);
    }
    this.paused.set(parsed.data.requestId, parsed.data.request.url);
  }

  /** A CDP command from the daemon, on its way to the view. */
  command(method: string, params: unknown): void {
    if (method !== "Fetch.continueRequest" && method !== "Fetch.failRequest") return;
    const parsed = Continued.safeParse(params);
    if (!parsed.success) return;
    const url = this.paused.get(parsed.data.requestId);
    this.paused.delete(parsed.data.requestId);
    if (method !== "Fetch.continueRequest" || !url) return;
    const origin = socketOrigin(url);
    if (!origin) return;
    if (this.approved.size >= maxApproved) {
      const oldest = this.approved.values().next();
      if (!oldest.done) this.approved.delete(oldest.value);
    }
    this.approved.add(origin);
  }

  allows(socketUrl: string): boolean {
    try {
      const url = new URL(socketUrl);
      if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
      return this.approved.has(url.origin);
    } catch {
      return false;
    }
  }
}

/** The WebSocket origin an approved http(s) URL stands for. */
function socketOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    else return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}
