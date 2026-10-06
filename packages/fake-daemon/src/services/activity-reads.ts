import type { ActivityReadCursor, ActivityReadsRequest, ServerMessage } from "@ace/protocol";
import { applyActivityReads } from "@ace/projection/activity-reads";

/**
 * The daemon's Activity read cursor: one per fake daemon, started at the first read, merged
 * per change with the shared rule, and pushed to every authenticated connection, as the
 * daemon does.
 */
export class FakeActivityReads {
  private cursor: ActivityReadCursor | undefined;
  private readonly clock: () => number;
  private readonly broadcast: (message: ServerMessage) => void;
  constructor(clock: () => number, broadcast: (message: ServerMessage) => void) {
    this.clock = clock;
    this.broadcast = broadcast;
  }
  /** The cursor as it stands; tests stage one with `set`. */
  get(): ActivityReadCursor {
    this.cursor ??= { before: this.clock(), read: [], unread: [], revision: 0 };
    return this.cursor;
  }
  set(cursor: ActivityReadCursor): void {
    this.cursor = cursor;
    this.broadcast({ type: "activity.reads.changed", cursor });
  }
  handle(message: ActivityReadsRequest): ServerMessage {
    if (message.type === "activity.markRead") {
      this.cursor = applyActivityReads(this.get(), {
        read: message.read,
        unread: message.unread,
        allBefore: message.allBefore,
      });
      this.broadcast({ type: "activity.reads.changed", cursor: this.cursor });
    }
    return { type: "activity.reads.result", requestId: message.requestId, cursor: this.get() };
  }
}
