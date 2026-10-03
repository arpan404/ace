import { ThreadId } from "@ace/protocol";
import { organizeThread, organizationCommands } from "../thread-organization.ts";
import { ThreadOrganizer } from "../thread-organizer.ts";
import type { ServiceContext } from "./types.ts";
import type { SocketContext, SocketService } from "./socket.ts";

export function startThreadOrganization({ store, services, resources, now }: ServiceContext): void {
  const organizer = new ThreadOrganizer(store, services.settings, now);
  resources.own(() => organizer.close());
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
      accept(command, device) {
        const receipt = options.store.commandReceipt(command.id, device);
        if (receipt) {
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
        const result = options.store.recordCommand(command.id, device, () =>
          organizeThread(
            options.store,
            command,
            (options.now ?? Date.now)(),
            (id) => options.workspaceActions?.hasOwnedWork(id) ?? false,
          ),
        );
        send({ type: "commandResult", ...result });
      },
    },
  };
}
