import type { Fact } from "@ace/core";
import type { CommandPayload, EventPayload, ServerMessage } from "@ace/protocol";
import type { QueueGet } from "@ace/protocol/queue";
import type { ThreadHost } from "./thread-host.ts";

type ThreadLimit = Extract<CommandPayload, { type: "thread.limit" }>;
type QueueResultMessage = Extract<ServerMessage, { type: "queue.result" }>;

/**
 * The daemon's queue revisions and limit recovery, as far as the fake needs them: `queue.get`
 * reports a thread's revision (the fake keeps no queued-message pages), and `thread.limit`
 * moves a limited thread to another account (`migrate_now`) or resumes it now. Every accepted
 * command bumps the revision, so a stale `expectedRevision` is refused like the daemon does.
 */
export class FakeLimitRecovery {
  private revisions = new WeakMap<ThreadHost, number>();

  revision(host: ThreadHost): number {
    return this.revisions.get(host) ?? 0;
  }

  queue(host: ThreadHost, request: QueueGet): QueueResultMessage {
    const limited = host.view.thread.status.state === "limited";
    return {
      type: "queue.result",
      requestId: request.requestId,
      queue: {
        threadId: host.view.thread.id,
        revision: this.revision(host),
        paused: limited,
        reason: limited ? "limit" : null,
        resumeAt: null,
        messages: [],
        total: host.queued.length,
        next: null,
      },
    };
  }

  /**
   * What `thread.limit` does to a thread: the live account it moves to and the facts that end
   * its limited state. Snoozing or resuming at the reset needs a reset time the fake never has.
   */
  limit(
    host: ThreadHost,
    payload: ThreadLimit,
  ): { error: string } | { events: EventPayload[]; facts: Fact[] } {
    if (payload.expectedRevision !== this.revision(host)) return { error: "revision_conflict" };
    if (host.view.thread.status.state !== "limited") return { error: "not_limited" };
    if (payload.action === "resume_at_reset" || payload.action === "snooze_until_reset")
      return { error: "reset_time_unknown" };
    this.revisions.set(host, this.revision(host) + 1);
    const events: EventPayload[] =
      payload.action === "migrate_now" && payload.instanceId
        ? [
            {
              type: "thread.client.updated",
              changes: { live: { ...host.view.thread.live, account: payload.instanceId } },
            },
          ]
        : [];
    return { events, facts: [{ type: "limit.cleared", agent: "root" }] };
  }
}
