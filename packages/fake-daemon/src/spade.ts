import type { ClientMessage, ServerMessage, SpadeMethod, SpadeStatus } from "@ace/protocol";

/** One request to Spade's API as the daemon would forward it. */
export interface FakeSpadeRequest {
  method: SpadeMethod;
  path: string;
  body: string | undefined;
}

export interface FakeSpadeAnswer {
  status: number;
  body?: string;
  contentType?: string;
}

/** Spade's local API behind the daemon: answers requests and opens live streams. */
export interface FakeSpadeServer {
  answer(request: FakeSpadeRequest): FakeSpadeAnswer;
  /** Frames a new live stream on `path` starts with (its backlog). */
  open?(path: string): { event: string; data: string }[];
}

type Push = (message: ServerMessage) => void;
type HttpRequest = Extract<ClientMessage, { type: "spade.http" }>;

/**
 * Spade as the daemon reaches it (ADR 0121): its status, and, once a test or the fake app
 * serves an API (`serve`), `spade.http` exchanges with inline bodies and `spade.live` streams
 * that stay open until unsubscribed. Tests set `status` to stage it, or `setStatus` to also tell
 * every socket that asked. `holding` keeps requests back to stage an answer that is late or lost.
 */
export class FakeSpade {
  status: SpadeStatus = { state: "off" };
  /**
   * While set, `spade.http` requests wait until the test lets them through (`letThrough`): every
   * one, or only those the function picks.
   */
  holding: boolean | ((request: { method: string; path: string }) => boolean) = false;
  private server: FakeSpadeServer | undefined;
  private readonly streams = new Map<string, { path: string; push: Push }>();
  private readonly watchers = new Set<Push>();
  private readonly held: { message: HttpRequest; push: Push }[] = [];

  serve(server: FakeSpadeServer | undefined): void {
    this.server = server;
  }

  /** Sends a frame to every open stream whose path starts with `prefix`. */
  emit(prefix: string, event: string, data: unknown): void {
    for (const [requestId, stream] of this.streams)
      if (stream.path.startsWith(prefix))
        stream.push({ type: "spade.live.frame", requestId, event, data: JSON.stringify(data) });
  }

  /** Spade's status changes; every socket that asked hears it, as from the daemon. */
  setStatus(status: SpadeStatus): void {
    this.status = status;
    for (const push of this.watchers) push({ type: "spade.status.changed", status });
    if (status.state === "ready") return;
    // Spade stopped: the daemon ends its streams as restarted.
    for (const [requestId, stream] of this.streams)
      stream.push({ type: "spade.live.ended", requestId, reason: "restarted" });
    this.streams.clear();
  }

  /** Requests waiting while `holding`. */
  get waiting(): number {
    return this.held.length;
  }

  /**
   * Let the held requests through, and stop holding. `reply: false` does what each asks but
   * sends no reply, as when the answer is lost with the connection.
   */
  letThrough(reply = true): void {
    this.holding = false;
    for (const { message, push } of this.held.splice(0)) {
      const result = this.http(message);
      if (reply) push({ type: "spade.http.result", requestId: message.requestId, result });
    }
  }

  /** A socket closed: its status watch and streams end with it. */
  release(push: Push): void {
    this.watchers.delete(push);
    for (const [id, stream] of this.streams) if (stream.push === push) this.streams.delete(id);
  }

  /** True when it answered `message`. */
  handle(message: ClientMessage, push: Push): boolean {
    switch (message.type) {
      case "spade.status":
        this.watchers.add(push);
        push({ type: "spade.status.result", requestId: message.requestId, status: this.status });
        return true;
      case "spade.http":
        if (this.holding === true || (this.holding && this.holding(message)))
          this.held.push({ message, push });
        else
          push({
            type: "spade.http.result",
            requestId: message.requestId,
            result: this.http(message),
          });
        return true;
      case "spade.live.subscribe": {
        const server = this.server;
        if (!server || this.status.state !== "ready") {
          push({ type: "spade.live.ended", requestId: message.requestId, reason: "unavailable" });
          return true;
        }
        this.streams.set(message.requestId, { path: message.path, push });
        for (const frame of server.open?.(message.path) ?? [])
          push({ type: "spade.live.frame", requestId: message.requestId, ...frame });
        return true;
      }
      case "spade.live.unsubscribe":
        this.streams.delete(message.requestId);
        return true;
      default:
        return false;
    }
  }

  private http(
    message: HttpRequest,
  ): Extract<ServerMessage, { type: "spade.http.result" }>["result"] {
    if (!this.server || this.status.state !== "ready")
      return { kind: "error", code: "unavailable", message: "Spade isn't running." };
    const answer = this.server.answer({
      method: message.method,
      path: message.path,
      body: message.body,
    });
    return {
      kind: "response",
      status: answer.status,
      body: answer.body ?? "",
      encoding: "text",
      contentType: answer.contentType ?? "application/json",
    };
  }
}
