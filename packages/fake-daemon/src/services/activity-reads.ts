import {
  applyActivityReads,
  type ActivityReadCursor,
  type ActivityReadsRequest,
  type ServerMessage,
} from "@ace/protocol";
import type { Push } from "./settings.ts";

/**
 * The daemon's Activity read cursor: one per fake daemon, started at the first read, merged
 * per change with the protocol's own rule, and pushed to every connection that has read it.
 */
export class FakeActivityReads {
  private cursor: ActivityReadCursor | undefined;
  private readonly readers = new Set<Push>();
  private readonly clock: () => number;
  constructor(clock: () => number) {
    this.clock = clock;
  }
  /** The cursor as it stands; tests stage one with `set`. */
  get(): ActivityReadCursor {
    this.cursor ??= { before: this.clock(), read: [], unread: [], revision: 0 };
    return this.cursor;
  }
  set(cursor: ActivityReadCursor): void {
    this.cursor = cursor;
    this.broadcast();
  }
  handle(message: ActivityReadsRequest, push: Push): ServerMessage {
    this.readers.add(push);
    if (message.type === "activity.markRead") {
      this.cursor = applyActivityReads(this.get(), {
        ...(message.read ? { read: message.read } : {}),
        ...(message.unread ? { unread: message.unread } : {}),
        ...(message.allBefore !== undefined ? { allBefore: message.allBefore } : {}),
      });
      this.broadcast();
    }
    return { type: "activity.reads.result", requestId: message.requestId, cursor: this.get() };
  }
  release(push: Push): void {
    this.readers.delete(push);
  }
  private broadcast(): void {
    const cursor = this.get();
    for (const push of this.readers) push({ type: "activity.reads.changed", cursor });
  }
}
