import { z } from "zod";

/** A CDP command on the view's root debugger session. */
export type RootSend = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const Paused = z.object({ requestId: z.string().min(1) });
const Nested = z.object({ sessionId: z.string().min(1), message: z.string() });
const Message = z.object({ method: z.string().optional(), params: z.unknown().optional() });
const decisions = new Set([
  "Fetch.continueRequest",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "Fetch.continueWithAuth",
  "Fetch.continueResponse",
]);
/** Ids for messages this tracker sends into nested targets; far from the daemon's own. */
const firstNestedId = 1_000_000_000;

export interface PausedRequest {
  /** Target session ids from the root to the paused request's target; empty for the root. */
  path: string[];
  requestId: string;
}

function parseMessage(raw: string): z.infer<typeof Message> | undefined {
  try {
    const parsed = Message.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The requests the daemon's origin guard has paused in a view (document loads, on the root
 * session or nested non-flattened targets) and not yet decided. While the daemon link is down
 * nobody can approve them, so they are refused instead of hanging, as are any paused later.
 * Refusing fails closed: a load the daemon never approved never runs.
 */
export class PausedRequests {
  private open = new Map<string, PausedRequest>();
  private nextId = firstNestedId;

  /** A root debugger event. Returns the requests it paused. */
  event(method: string, params: unknown): PausedRequest[] {
    const found: PausedRequest[] = [];
    this.walkEvent(method, params, [], found);
    for (const request of found) this.open.set(key(request), request);
    return found;
  }

  /** A root command about to be sent: a decision settles its paused request. */
  command(method: string, params: unknown): void {
    this.walkCommand(method, params, []);
  }

  /** Refuse every open request now; the tracker forgets them whether or not CDP accepts. */
  async refuseAll(send: RootSend): Promise<void> {
    const requests = [...this.open.values()];
    this.open.clear();
    await Promise.all(requests.map((request) => this.refuse(send, request)));
  }

  /** A fresh debugger session: nothing paused under the old one can be decided any more. */
  clear(): void {
    this.open.clear();
  }

  size(): number {
    return this.open.size;
  }

  async refuse(send: RootSend, request: PausedRequest): Promise<void> {
    this.open.delete(key(request));
    const params = { requestId: request.requestId, errorReason: "BlockedByClient" };
    let method = "Fetch.failRequest";
    let wrapped: Record<string, unknown> = params;
    for (const sessionId of request.path.toReversed()) {
      const message = JSON.stringify({ id: this.nextId++, method, params: wrapped });
      method = "Target.sendMessageToTarget";
      wrapped = { sessionId, message };
    }
    await send(method, wrapped).catch(() => {});
  }

  private walkEvent(method: string, params: unknown, path: string[], found: PausedRequest[]): void {
    if (method === "Fetch.requestPaused") {
      const paused = Paused.safeParse(params);
      if (paused.success) found.push({ path, requestId: paused.data.requestId });
      return;
    }
    if (method !== "Target.receivedMessageFromTarget") return;
    const nested = Nested.safeParse(params);
    // Most nested traffic is not a paused request: skip parsing it.
    if (!nested.success || !nested.data.message.includes("Fetch.requestPaused")) return;
    const inner = parseMessage(nested.data.message);
    if (inner?.method)
      this.walkEvent(inner.method, inner.params, [...path, nested.data.sessionId], found);
  }

  private walkCommand(method: string, params: unknown, path: string[]): void {
    if (decisions.has(method)) {
      const decided = Paused.safeParse(params);
      if (decided.success) this.open.delete(key({ path, requestId: decided.data.requestId }));
      return;
    }
    if (method !== "Target.sendMessageToTarget") return;
    const nested = Nested.safeParse(params);
    if (!nested.success || !nested.data.message.includes("Fetch.")) return;
    const inner = parseMessage(nested.data.message);
    if (inner?.method)
      this.walkCommand(inner.method, inner.params, [...path, nested.data.sessionId]);
  }
}

function key(request: PausedRequest): string {
  return `${request.path.join("/")}|${request.requestId}`;
}
