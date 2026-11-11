import type { ClientMessage, ServerMessage, SpadeStatus } from "@ace/protocol";

/** Spade's status as the daemon reports it (ADR 0121). Tests set `status` to stage it. */
export class FakeSpade {
  status: SpadeStatus = { state: "off" };

  /** True when it answered `message`. */
  handle(message: ClientMessage, push: (message: ServerMessage) => void): boolean {
    if (message.type !== "spade.status") return false;
    push({ type: "spade.status.result", requestId: message.requestId, status: this.status });
    return true;
  }
}
