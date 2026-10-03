import { outputStreamId } from "@ace/projection";
import type { EventPayload } from "@ace/protocol";

/** Per stream, as much as the daemon's stream store would keep for a client to page through. */
const streamLimit = 1024 * 1024;
const streamCount = 256;

/**
 * Shell output in full, as the daemon's stream store keeps it for `output.read` (ADR 0006): the
 * projection keeps only a 4 KiB tail. Bounded per stream and in streams, oldest dropped first.
 */
export class FakeOutputStore {
  private streams = new Map<string, Uint8Array>();
  private encoder = new TextEncoder();
  record(payload: EventPayload): void {
    if (payload.type !== "item.delta" || payload.field !== "output") return;
    const id = outputStreamId(payload.itemId);
    const previous = this.streams.get(id) ?? new Uint8Array();
    const added = this.encoder.encode(payload.append);
    const next = new Uint8Array(Math.min(streamLimit, previous.length + added.length));
    next.set(previous.subarray(0, next.length));
    if (next.length > previous.length)
      next.set(added.subarray(0, next.length - previous.length), previous.length);
    this.streams.delete(id);
    this.streams.set(id, next);
    if (this.streams.size > streamCount) {
      const oldest = this.streams.keys().next().value;
      if (oldest !== undefined) this.streams.delete(oldest);
    }
  }
  read(
    streamId: string,
    offset: number,
    limit: number,
  ): { bytes: Uint8Array; nextOffset: number; eof: boolean } | undefined {
    const stream = this.streams.get(streamId);
    if (!stream || offset > stream.length) return undefined;
    const bytes = stream.subarray(offset, offset + limit);
    const nextOffset = offset + bytes.length;
    return { bytes, nextOffset, eof: nextOffset >= stream.length };
  }
}
