import { accountName, providerDisplayName } from "@ace/ui-core";
import { blockedUntil } from "@ace/accounts/availability";
import type { AccountSummary } from "@ace/protocol/accounts";
import type { Fact } from "@ace/core";
import { QueuePage, type CommandPayload, type ThreadId } from "@ace/protocol";
import {
  admissionFacts,
  inputText,
  steerFacts,
  type ThreadCommandOutcome,
} from "./thread-commands.ts";
import type { FakeQueued, ThreadHost } from "./thread-host.ts";

/*
 * The fake daemon's server queue (ADR 0053): edit, move, remove, pause and resume with a
 * revision check, the limit actions, and `queue.get` pages. Pure over the host: returns the
 * facts to apply and marks the queue dirty so the daemon publishes `queue.updated`.
 */

type QueueCommand = Extract<
  CommandPayload,
  {
    type:
      | "queue.resend"
      | "queue.edit"
      | "queue.move"
      | "queue.remove"
      | "queue.pause"
      | "queue.resume"
      | "thread.resume"
      | "thread.limit";
  }
>;

export const queueCommandTypes: readonly QueueCommand["type"][] = [
  "queue.resend",
  "queue.edit",
  "queue.move",
  "queue.remove",
  "queue.pause",
  "queue.resume",
  "thread.resume",
  "thread.limit",
];

export function isQueueCommand(payload: CommandPayload): payload is QueueCommand {
  return queueCommandTypes.some((type) => type === payload.type);
}

const fail = (error: string): ThreadCommandOutcome => ({ ok: false, error });

function hold(host: ThreadHost, reason: FakeQueuedHold, resumeAt: number | null) {
  host.queue.paused = true;
  host.queue.reason = reason;
  host.queue.resumeAt = resumeAt;
  host.queueDirty = true;
}
type FakeQueuedHold = NonNullable<ThreadHost["queue"]["reason"]>;

/** Release the hold, clear quota evidence, and let the queue drain. */
function release(host: ThreadHost): Fact[] {
  host.queue.paused = false;
  host.queue.reason = null;
  host.queue.resumeAt = null;
  host.queueDirty = true;
  const root = host.state.rootKey;
  return root !== undefined && host.state.agents[root]?.limited
    ? [{ type: "limit.cleared", agent: root }]
    : [];
}

function limitedUntil(host: ThreadHost): number | undefined {
  const status = host.view.thread.status;
  return status.state === "limited" ? status.until : undefined;
}

export function queueCommand(
  host: ThreadHost,
  payload: QueueCommand,
  now: number,
  commandId: string,
  account?: AccountSummary,
): ThreadCommandOutcome {
  if (payload.expectedRevision !== host.queue.revision) return fail("queue_conflict");
  const index =
    "messageId" in payload ? host.queued.findIndex((m) => m.key === payload.messageId) : -1;
  const message = index >= 0 ? host.queued[index] : undefined;
  if ("messageId" in payload && !message) return fail("message_already_claimed");
  switch (payload.type) {
    case "queue.resend": {
      if (!message || message.state !== "uncertain") return fail("message_not_uncertain");
      host.queued.splice(index, 1);
      host.queued.push({ ...message, key: commandId, state: "queued" });
      if (host.queue.reason === "uncertain" && !host.queued.some((m) => m.state === "uncertain")) {
        host.queue.paused = false;
        host.queue.reason = null;
      }
      host.queueDirty = true;
      return { ok: true, facts: [] };
    }
    case "queue.edit": {
      if (!message) return fail("message_already_claimed");
      if (message.state === "uncertain") return fail("uncertain_delivery");
      const edited: FakeQueued = {
        ...message,
        input: [...payload.input],
        context: payload.context,
        delivery: payload.delivery ?? message.delivery,
        text: inputText(payload.input, payload.context),
      };
      // Steering a waiting message delivers it into the running turn now.
      if (edited.delivery === "steer" && !host.queue.paused) {
        host.queued.splice(index, 1);
        host.queueDirty = true;
        return {
          ok: true,
          facts: [
            ...admissionFacts(host, edited.key, edited.input, edited.attachments),
            ...steerFacts(host, edited.key, edited.text),
            { type: "queue.changed", count: host.queued.length },
          ],
        };
      }
      host.queued[index] = edited;
      host.queueDirty = true;
      return { ok: true, facts: [] };
    }
    case "queue.move": {
      if (!message) return fail("message_already_claimed");
      if (host.queued.some((m) => m.state === "uncertain")) return fail("uncertain_delivery");
      const rest = host.queued.filter((m) => m.key !== message.key);
      const at = payload.after === null ? 0 : rest.findIndex((m) => m.key === payload.after) + 1;
      if (payload.after !== null && at === 0) return fail("invalid_queue_position");
      rest.splice(at, 0, message);
      host.queued = rest;
      host.queueDirty = true;
      return { ok: true, facts: [] };
    }
    case "queue.remove":
      host.queued.splice(index, 1);
      host.queueDirty = true;
      return { ok: true, facts: [{ type: "queue.changed", count: host.queued.length }] };
    case "queue.pause":
      hold(host, "manual", null);
      return { ok: true, facts: [] };
    case "queue.resume":
    case "thread.resume":
      if (host.queued.some((m) => m.state === "uncertain")) return fail("uncertain_delivery");
      return { ok: true, facts: release(host) };
    case "thread.limit": {
      if (payload.action === "resume_at_reset" || payload.action === "snooze_until_reset") {
        const accountReset = account ? blockedUntil(account.quota, now) : undefined;
        const reset =
          accountReset === undefined
            ? (limitedUntil(host) ?? host.queue.resumeAt ?? undefined)
            : accountReset;
        if (reset === null || reset === undefined || reset <= now)
          return fail("reset_time_unknown");
        hold(host, payload.action === "resume_at_reset" ? "limit" : "snooze", reset);
        return { ok: true, facts: [] };
      }
      if (payload.action === "migrate_now") {
        const root = host.state.rootKey;
        const notice: Fact[] =
          root === undefined
            ? []
            : [
                {
                  type: "item.upsert",
                  agent: root,
                  item: `migrated-${now}`,
                  draft: {
                    type: "notice",
                    complete: true,
                    level: "info",
                    text: `Moved to ${account ? accountName({ ...account, providerLabel: providerDisplayName(account.provider) }) : "another account"} after the usage limit.`,
                  },
                },
              ];
        return { ok: true, facts: [...release(host), ...notice] };
      }
      return { ok: true, facts: release(host) };
    }
  }
}

/** A rate limit holds the queue until the person chooses what to do. */
export function holdOnLimit(host: ThreadHost): void {
  if (host.view.thread.status.state === "limited" && !host.queue.paused) hold(host, "limit", null);
}

/** One `queue.get` page: up to `limit` messages after `after`, oldest first. */
export function queuePage(
  host: ThreadHost,
  threadId: ThreadId,
  request: {
    after?: string | undefined;
    expectedRevision?: number | undefined;
    limit?: number | undefined;
  },
): QueuePage | string {
  if (request.expectedRevision !== undefined && request.expectedRevision !== host.queue.revision)
    return "queue_conflict";
  const start =
    request.after === undefined ? 0 : host.queued.findIndex((m) => m.key === request.after) + 1;
  if (request.after !== undefined && start === 0) return "queue_conflict";
  const limit = request.limit ?? 32;
  const slice = host.queued.slice(start, start + limit);
  return QueuePage.parse({
    ...host.queue,
    threadId,
    total: host.queued.length,
    next: start + limit < host.queued.length ? (slice.at(-1)?.key ?? null) : null,
    messages: slice.map((m) =>
      m.context
        ? { id: m.key, input: m.input, context: m.context, delivery: m.delivery, state: m.state }
        : { id: m.key, input: m.input, delivery: m.delivery, state: m.state },
    ),
  });
}
