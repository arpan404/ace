import { ActivityReadsRequest } from "@ace/protocol";
import { ActivityReads } from "../activity-reads.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startActivityReads({ store, services, now }: ServiceContext): void {
  services.activityReads = new ActivityReads(store, now);
}

/**
 * `activity.reads` and `activity.markRead`. Marking read is part of reading (like
 * `thread.markRead`), so read scope is enough; every reader hears the change.
 */
export function createActivityReadsSession({
  options,
  authorize,
  connected,
  send,
  fail,
}: SocketContext): SocketService {
  let stop: (() => void) | undefined;
  return {
    authenticated() {
      stop = options.activityReads?.subscribe((change) => {
        if (connected() && authorize("read")) send(change);
      });
    },
    close() {
      stop?.();
    },
    handle(message) {
      if (message.type !== "activity.reads" && message.type !== "activity.markRead") return false;
      const request = ActivityReadsRequest.parse(message);
      const reads = options.activityReads;
      if (!authorize("read") || !reads) {
        fail(
          reads ? "forbidden" : "activity_unavailable",
          "Activity read state unavailable",
          false,
          { requestId: request.requestId },
        );
        return true;
      }
      const cursor =
        request.type === "activity.reads"
          ? reads.get()
          : reads.mark({
              ...(request.read ? { read: request.read } : {}),
              ...(request.unread ? { unread: request.unread } : {}),
              ...(request.allBefore !== undefined ? { allBefore: request.allBefore } : {}),
            });
      send({ type: "activity.reads.result", requestId: request.requestId, cursor });
      return true;
    },
  };
}
