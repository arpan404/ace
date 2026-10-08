import { useClient } from "@ace/client-react";
import { ThreadId, type PermissionMode, type PermissionState } from "@ace/protocol";
import { runCommand } from "@/lib/daemon-command.ts";
import { choiceKind, usePendingChoice } from "./pending-choice.ts";

export { usePermissionCapabilities, usePermissionModes } from "@/lib/use-permission-modes.ts";

const permissionChoices = choiceKind<PermissionMode | null>();

/**
 * A thread's approval mode as this device last chose it, and the way to change it. The change
 * shows at once (`chosen`, with `note` while the daemon hasn't got it) and is a durable command:
 * offline it waits, and only the daemon's refusal takes it back, rejecting `change`.
 */
export function useThreadPermission(threadId: string, state: PermissionState | undefined) {
  const client = useClient();
  const pending = usePendingChoice(permissionChoices, threadId, JSON.stringify(state ?? null));
  return {
    /** A mode not yet reported by the daemon; `null` is "back to the default". */
    chosen: pending.chosen?.value,
    note: pending.note,
    /** Set the thread's own mode, or `null` to follow the project and global default again. */
    change: (mode: PermissionMode | null) =>
      pending.choose(mode, () =>
        runCommand(client, {
          type: "thread.permission.set",
          threadId: ThreadId.parse(threadId),
          permissionMode: mode,
        }),
      ),
  };
}
