import { useClient } from "@ace/client-react";
import { ThreadId, type AccessMode, type PermissionState } from "@ace/protocol";
import { runCommand } from "@/lib/daemon-command.ts";
import { choiceKind, usePendingChoice } from "./pending-choice.ts";

export { useAccessModes } from "@/lib/use-permission-modes.ts";

const accessChoices = choiceKind<AccessMode | null>();

/**
 * A thread's access as this device last chose it, and the way to change it. The change shows
 * at once (`chosen`, with `note` while the daemon hasn't got it) and is a durable command:
 * offline it waits, and only the daemon's refusal takes it back, rejecting `change`. It changes
 * this thread only; the default for new threads is set in Settings.
 */
export function useThreadPermission(threadId: string, state: PermissionState | undefined) {
  const client = useClient();
  const pending = usePendingChoice(accessChoices, threadId, JSON.stringify(state ?? null));
  return {
    /** A mode not yet reported by the daemon; `null` is "back to the default". */
    chosen: pending.chosen?.value,
    note: pending.note,
    change: (mode: AccessMode | null) =>
      pending.choose(mode, () =>
        runCommand(client, {
          type: "thread.permission.set",
          threadId: ThreadId.parse(threadId),
          access: mode,
        }),
      ),
  };
}
