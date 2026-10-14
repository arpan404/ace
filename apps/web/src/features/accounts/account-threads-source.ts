/* Moving an exhausted account's limited threads with `thread.limit` / `migrate_now`. */
import { useClient } from "@ace/client-react";
import { migrationTarget, type AccountView } from "@ace/ui-core";
import { ThreadId } from "@ace/protocol";
import { useMutation } from "@tanstack/react-query";

export interface MoveResult {
  moved: number;
  failed: number;
  to: AccountView;
}

/** "Moved 3 threads to Codex · Personal; 1 couldn't move": a move's outcome as a toast says it. */
export function describeMove(result: MoveResult): string {
  const threads = `${result.moved} ${result.moved === 1 ? "thread" : "threads"}`;
  const failed = result.failed ? `; ${result.failed} couldn't move` : "";
  return `Moved ${threads} to ${result.to.providerLabel} · ${result.to.label}${failed}`;
}

/**
 * Moves each limited thread to the account automatic recovery would pick (the first other
 * account of the provider that is available). Every thread is its own `thread.limit` command
 * against its current queue revision, so one refusal doesn't stop the others.
 */
export function useMoveThreads() {
  const client = useClient();
  return useMutation({
    mutationFn: async (input: {
      accounts: readonly AccountView[];
      from: string;
      threadIds: readonly string[];
    }): Promise<MoveResult> => {
      const to = migrationTarget(input.accounts, input.from, Date.now());
      if (!to) throw new Error("No other account for this provider is available.");
      if (!input.threadIds.length) throw new Error("There are no threads to move.");
      const results = await Promise.all(
        input.threadIds.map(async (id) => {
          try {
            const threadId = ThreadId.parse(id);
            const { queue } = await client.request({ type: "queue.get", threadId, limit: 1 });
            const result = await client.command({
              type: "thread.limit",
              threadId,
              expectedRevision: queue.revision,
              action: "migrate_now",
              instanceId: to.id,
            });
            return result.ok;
          } catch {
            return false;
          }
        }),
      );
      const moved = results.filter(Boolean).length;
      if (!moved) throw new Error(`Couldn't move threads to ${to.providerLabel} · ${to.label}.`);
      return { moved, failed: results.length - moved, to };
    },
  });
}
