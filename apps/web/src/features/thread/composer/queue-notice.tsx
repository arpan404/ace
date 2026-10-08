import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ThreadStatus } from "@ace/protocol";
import {
  ArrowClockwiseIcon,
  HourglassMediumIcon,
  MoonIcon,
  PauseIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { limitContext, queueNotice, type QueueNotice as Notice } from "@ace/ui-core";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
import { useThreadAccount } from "../lib/thread-account.ts";
import type { QueueControls } from "./use-queue.ts";

const icons: Record<Notice["kind"], typeof PauseIcon> = {
  limited: HourglassMediumIcon,
  resuming: HourglassMediumIcon,
  snoozed: MoonIcon,
  restart: ArrowClockwiseIcon,
  uncertain: WarningIcon,
  paused: PauseIcon,
};

const holdOf = (reader: ThreadReader) => reader.queue;

/**
 * Above the composer while the queue is held: a usage limit (with when it resets, and resume
 * now, resume at reset, snooze until reset or move to the account with the most room, named), a
 * restart that stopped the agent, or a manual pause, each with its way out.
 */
export function QueueNotice(props: {
  threadId: string;
  status: ThreadStatus | undefined;
  queue: QueueControls;
}) {
  const live = useThread(props.threadId, ["queue"], holdOf);
  const now = useNow();
  // What accounts.list says about the account it ran out on: its reset, and where Move goes.
  const { account, accounts } = useThreadAccount(props.threadId);
  const context = account && accounts ? limitContext(accounts, account.id, now) : undefined;
  const notice = queueNotice(props.status, live ?? props.queue.page, now, undefined, context);
  if (!notice) return null;
  const [primary, ...rest] = notice.actions;
  return (
    <section
      aria-label={notice.title}
      className="fx-rise-in mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 px-2 py-1 text-ui"
    >
      <Icon icon={icons[notice.kind]} size={16} className="text-muted-foreground" />
      {/* The words keep a readable width; the actions wrap under them when they can't fit. */}
      <div className="min-w-65 flex-1">
        <p className="font-medium text-foreground">{notice.title}</p>
        <p className="text-sm text-muted-foreground">{notice.detail}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {rest.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant="ghost"
            disabled={props.queue.acting}
            onClick={() => props.queue.act(action)}
          >
            {action.label}
          </Button>
        ))}
        {primary && (
          <Button
            size="sm"
            variant="primary"
            disabled={props.queue.acting}
            onClick={() => props.queue.act(primary)}
          >
            {primary.label}
          </Button>
        )}
      </div>
    </section>
  );
}
