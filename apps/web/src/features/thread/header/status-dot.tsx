import type { ThreadStatus } from "@ace/protocol";
import { threadStatusLabel, type Tone } from "@ace/ui-core";
import { cn } from "@/lib/cn.ts";

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
 * shows one. Named for assistive tech ("Working"), never colour alone.
 */
export function ThreadStatusDot(props: { status: ThreadStatus }) {
  const { label, tone } = threadStatusLabel(props.status);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-block size-2 shrink-0 rounded-full", tones[tone])}
    />
  );
}
