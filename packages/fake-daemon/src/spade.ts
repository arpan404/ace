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

/**
 * Spade as the daemon reaches it (ADR 0121): its status, and, once a test or the fake app
 * serves an API (`serve`), `spade.http` exchanges with inline bodies and `spade.live` streams
 * that stay open until unsubscribed. Tests set `status` to stage it.
 */
export class FakeSpade {
  status: SpadeStatus = { state: "off" };
  private server: FakeSpadeServer | undefined;
  private readonly streams = new Map<string, { path: string; push: Push }>();

  serve(server: FakeSpadeServer | undefined): void {
    this.server = server;
  }

  /** Sends a frame to every open stream whose path starts with `prefix`. */
  emit(prefix: string, event: string, data: unknown): void {
    for (const [requestId, stream] of this.streams)
      if (stream.path.startsWith(prefix))
        stream.push({ type: "spade.live.frame", requestId, event, data: JSON.stringify(data) });
  }

  /** True when it answered `message`. */
  handle(message: ClientMessage, push: Push): boolean {
    switch (message.type) {
      case "spade.status":
        push({ type: "spade.status.result", requestId: message.requestId, status: this.status });
        return true;
      case "spade.http":
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
    message: Extract<ClientMessage, { type: "spade.http" }>,
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
