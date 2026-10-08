import type { ThreadRunMetadata, ThreadStatus } from "@ace/protocol";
import {
  describeLive,
  liveStatusText,
  threadLiveFact,
  threadStatusLabel,
  type Tone,
} from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";

const tones: Record<Tone, string> = {
  working: "bg-status-working",
  "needs-you": "bg-status-needs-you",
  waiting: "bg-status-waiting",
  failed: "bg-status-failed",
  done: "bg-status-done",
  idle: "bg-subtle-foreground",
};

/**
 * The thread's status as a dot after its title on a phone, where no thread list beside it
 * shows one. Named for assistive tech ("Working", "Waiting on 2 subagents"), never colour alone.
 */
export function ThreadStatusDot(props: {
  thread: { status: ThreadStatus; live?: ThreadRunMetadata | undefined };
}) {
  const now = useNow();
  const fact = threadLiveFact(props.thread);
  const live = fact && describeLive(fact, now);
  const { label, tone } = live
    ? { label: liveStatusText(live), tone: live.tone }
    : threadStatusLabel(props.thread.status);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-block size-2 shrink-0 rounded-full", tones[tone])}
    />
  );
}
