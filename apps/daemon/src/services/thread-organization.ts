import { ThreadId } from "@ace/protocol";
import { organizeThread, organizationCommands } from "../thread-organization.ts";
import { ThreadOrganizer } from "../thread-organizer.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";
import { backgroundFailure } from "./background.ts";

export function startThreadOrganization(context: ServiceContext): void {
  const { store, services, resources, now } = context;
  const organizer = new ThreadOrganizer(
    store,
    services.settings,
    now,
    undefined,
    backgroundFailure(context, "Thread organizer could not queue a thread; retrying"),
  );
  // A mark a full disk held back is written as soon as space is back (ADR 0176).
  const stopResuming = context.diskFull?.onRoom(() => organizer.resume());
  resources.own(() => {
    stopResuming?.();
    return organizer.close();
  });
}
export function createThreadOrganizationSession({
  options,
  send,
  canReadThread,
}: SocketContext): SocketService {
  return {
    command: {
      types: organizationCommands,
      scope: () => "operate",
      async accept(command, device) {
        const receipt = options.store.commandReceipt(command.id, device);
        if (receipt && receipt.error !== "client_action_pending") {
          send({ type: "commandResult", ...receipt });
          return;
        }
        if (
          !("threadId" in command.payload) ||
          !canReadThread(ThreadId.parse(command.payload.threadId))
        ) {
          send({ type: "commandResult", commandId: command.id, ok: false, error: "forbidden" });
          return;
        }
        if (command.payload.type === "thread.delete" && options.threadLifecycle) {
          try {
            const result = await options.threadLifecycle.delete(command);
            send({ type: "commandResult", ...result });
          } catch (error) {
            options.log?.(error);
            send({
              type: "commandResult",
              commandId: command.id,
              ok: false,
              error: "thread_cleanup_pending",
            });
          }
          return;
        }
        const result = options.store.recordCommand(command.id, device, () =>
          organizeThread(
            options.store,
            command,
            (options.now ?? Date.now)(),
            (id) => options.workspaceActions?.hasOwnedWork(id) ?? false,
            (id, opening) => options.utility?.titles.regenerate(id, opening),
          ),
        );
        send({ type: "commandResult", ...result });
      },
    },
  };
}
