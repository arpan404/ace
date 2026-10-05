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
import { queueNotice, type QueueNotice as Notice } from "@ace/ui-core";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useNow } from "@/lib/time.ts";
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
 * now, resume at reset, snooze until reset or move to another account), a restart that stopped
 * the agent, or a manual pause, each with its way out.
 */
export function QueueNotice(props: {
  threadId: string;
  status: ThreadStatus | undefined;
  queue: QueueControls;
}) {
  const live = useThread(props.threadId, ["queue"], holdOf);
  const now = useNow();
  const notice = queueNotice(props.status, live ?? props.queue.page, now);
  if (!notice) return null;
  const [primary, ...rest] = notice.actions;
  return (
    <section
      aria-label={notice.title}
      className="fx-rise-in glass mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl py-2 pr-2 pl-3 text-ui"
    >
      <Icon icon={icons[notice.kind]} size={16} className="text-muted-foreground" />
      <div className="min-w-0 flex-1">
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
            onClick={() => props.queue.act(action.id)}
          >
            {action.label}
          </Button>
        ))}
        {primary && (
          <Button
            size="sm"
            variant="primary"
            disabled={props.queue.acting}
            onClick={() => props.queue.act(primary.id)}
          >
            {primary.label}
          </Button>
        )}
      </div>
    </section>
  );
}
