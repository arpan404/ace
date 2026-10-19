import { useThreadMeta } from "@ace/client-react";
import { formatAgo } from "@ace/ui-core";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { useThreadActions } from "@/features/organize/index.ts";
import { useNow } from "@/lib/time.ts";

/**
 * "Settled 2h ago · Unsettle" under the last message of a settled thread. Unsettling brings it
 * back to the list and keeps it there: the thread stops settling by itself until the person
 * turns auto-settle back on.
 */
export function SettledLine(props: { threadId: string }) {
  const meta = useThreadMeta(props.threadId);
  const actions = useThreadActions();
  const now = useNow();
  if (meta?.settledAt === undefined) return null;
  return (
    <div role="status" className="mt-6 flex items-center gap-1.5 text-xs text-muted-foreground">
      <CheckCircleIcon aria-hidden size={14} />
      <span>Settled {formatAgo(meta.settledAt, now)}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className="rounded-sm hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => actions.unsettle(meta)}
      >
        Unsettle
      </button>
    </div>
  );
}
