import { PermissionClient } from "@ace/client";
import { useClient } from "@ace/client-react";
import {
  ThreadId,
  type PermissionCapabilities,
  type PermissionMode,
  type PermissionState,
  type ProviderKind,
} from "@ace/protocol";
import { runCommand } from "@/lib/daemon-command.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { choiceKind, usePendingChoice } from "./pending-choice.ts";

/**
 * What a provider can gate in each permission mode (`permissions.capabilities`), for a thread
 * that doesn't exist yet or one whose live capabilities haven't arrived. `live` wins.
 */
export function usePermissionCapabilities(
  provider: ProviderKind | undefined,
  live?: PermissionCapabilities | undefined,
): { capabilities: PermissionCapabilities | undefined; loading: boolean; failed: boolean } {
  const query = useDaemonQuery({
    queryKey: ["permissions", "capabilities", provider],
    enabled: !!provider && !live,
    staleTime: 5 * 60_000,
    read: async (client, signal) => {
      if (!provider) return undefined;
      const reply = await new PermissionClient(client).getCapabilities(provider, undefined, {
        signal,
      });
      if (!reply.ok) throw new Error(reply.error ?? "unavailable");
      return reply.permissions;
    },
  });
  if (live) return { capabilities: live, loading: false, failed: false };
  return {
    capabilities: query.data,
    loading: !!provider && query.data === undefined && !query.isError,
    failed: query.isError,
  };
}

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
