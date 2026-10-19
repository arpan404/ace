import { ComputerUsingWatch } from "@ace/protocol";
import type { ThreadApps } from "../computer-using.ts";
import type { SocketContext, SocketService } from "./socket.ts";

/**
 * `computer.using.watch`: the threads this client may read whose agent is using Mac apps, and
 * which, now and again on every change, for the task list's indicator. A daemon without
 * computer use answers with nobody.
 */
export function createComputerUsingSession({
  options,
  authorize,
  canReadThread,
  connected,
  send,
  fail,
}: SocketContext): SocketService {
  let stop: (() => void) | undefined;
  const report = (threads: readonly ThreadApps[]) => {
    if (!connected() || !authorize("read")) return;
    send({
      type: "computer.using",
      threads: threads
        .filter((entry) => canReadThread(entry.threadId))
        .slice(0, 512)
        .map((entry) => ({ threadId: entry.threadId, apps: entry.apps.slice(0, 16) })),
    });
  };
  return {
    close() {
      stop?.();
    },
    handle(message) {
      if (message.type !== "computer.using.watch") return false;
      const request = ComputerUsingWatch.parse(message);
      if (!authorize("read")) {
        fail("forbidden", "Computer use state unavailable", false, {
          requestId: request.requestId,
        });
        return true;
      }
      const using = options.computerUsing;
      if (using) stop ??= using.subscribe(report);
      report(using?.threads() ?? []);
      return true;
    },
  };
}
