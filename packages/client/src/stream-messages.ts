import { decodeStreamMessage, StreamAssembler, type StreamMessage } from "@ace/browser/stream";
import { ClientError } from "./types.ts";

/**
 * Binary stream messages (`@ace/browser/stream`) on the connection, assembled from their pieces
 * and handed on decoded. A malformed piece is a protocol error: the connection drops and
 * reconnects. A kind this build doesn't know is skipped.
 */
export class StreamMessages {
  #assembler = new StreamAssembler();
  #deliver: (message: StreamMessage) => void;
  constructor(deliver: (message: StreamMessage) => void) {
    this.#deliver = deliver;
  }
  receive(bytes: Uint8Array): void {
    let message: StreamMessage | undefined;
    try {
      const envelope = this.#assembler.push(bytes);
      if (!envelope) return;
      message = decodeStreamMessage(envelope);
    } catch {
      throw new ClientError("protocol", "Unreadable stream message");
    }
    if (message) this.#deliver(message);
  }
  /** The connection ended: a message cut off mid-way never completes. */
  reset(): void {
    this.#assembler.reset();
  }
}
