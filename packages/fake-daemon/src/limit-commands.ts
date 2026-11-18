import type { AccountSummary } from "@ace/protocol/accounts";
import type { CommandId, CommandResult, EventPayload } from "@ace/protocol";
import { queueCommand, type QueueCommand } from "./queue-commands.ts";
import type { ThreadCommandOutcome } from "./thread-commands.ts";
import type { ThreadHost } from "./thread-host.ts";
import { limitSwitchEvents } from "./transitions.ts";

/*
 * The fake daemon's queue commands, with the moves a `thread.limit` makes. `queue-commands.ts`
 * decides the queue's facts; this module adds what a limited thread does next, as the daemon
 * does: a switch runs it on the chosen account from now on, and "migrate now" runs it on the
 * named account or, when none is named, the same provider's account with headroom.
 */

/** What the queue commands reach of the fake daemon. */
export interface LimitCommandHost {
  clock(): number;
  thread(id: string): ThreadHost | undefined;
  accounts(): readonly AccountSummary[];
  /** The account a thread moves to when "migrate now" names none. */
  migrationTarget(host: ThreadHost): string | undefined;
  run(
    commandId: CommandId,
    threadId: string,
    decide: (host: ThreadHost) => ThreadCommandOutcome,
  ): CommandResult;
  append(host: ThreadHost, payloads: EventPayload[], now: number): void;
}

/** Run one queue command against its thread, then apply a limit move's follow-on events. */
export function runQueueCommand(
  host: LimitCommandHost,
  payload: QueueCommand,
  commandId: CommandId,
): CommandResult {
  const result = host.run(commandId, payload.threadId, (thread) =>
    queueCommand(
      thread,
      payload,
      host.clock(),
      commandId,
      payload.type === "thread.limit"
        ? host
            .accounts()
            .find(
              (account) =>
                account.id ===
                (payload.action === "migrate_now"
                  ? (payload.instanceId ?? host.migrationTarget(thread))
                  : (thread.view.thread.live?.account ?? thread.view.thread.execution?.instanceId)),
            )
        : undefined,
    ),
  );
  const thread = host.thread(payload.threadId);
  if (!result.ok || !thread || payload.type !== "thread.limit") return result;
  if (payload.action === "switch")
    host.append(thread, limitSwitchEvents(thread, payload.selection, host.clock()), host.clock());
  if (payload.action === "migrate_now") {
    const account = payload.instanceId ?? host.migrationTarget(thread);
    if (account)
      host.append(
        thread,
        [
          {
            type: "thread.client.updated",
            changes: { live: { ...thread.view.thread.live, account } },
          },
        ],
        host.clock(),
      );
  }
  return result;
}
