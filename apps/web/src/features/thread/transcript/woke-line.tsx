import { useThreadMeta } from "@ace/client-react";
import { formatAgo, wokeAtEnd, wokeSentence } from "@ace/ui-core";
import { AlarmIcon } from "@phosphor-icons/react";
import { useNow } from "@/lib/time.ts";

/**
 * "Back from snooze: checks failed on #1477 · 2h ago" under the last message of a thread whose
 * snooze ended by itself, until it works again (`wokeAtEnd`).
 */
export function WokeLine(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  const now = useNow();
  const woke = meta && wokeAtEnd(meta, now);
  if (!woke) return null;
  return (
    <div role="status" className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
      <AlarmIcon aria-hidden size={14} weight="fill" className="shrink-0 text-foreground" />
      <span>{wokeSentence(woke)}</span>
      <span aria-hidden>·</span>
      <span>{formatAgo(woke.at, now)}</span>
    </div>
  );
}
