import { useThreadMeta } from "@ace/client-react";
import { describeLive, threadLiveFact } from "@ace/ui-core";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { StatusLabel } from "@/components/status-label.tsx";

/**
 * After the title in the header, what the thread is doing beyond its state, worded as the
 * sidebar row and the transcript's live line word it: "Watching `bun run dev:relay`", "Waiting
 * on 2 subagents", "Running tests…", "Waiting for your answer". A usage limit has its own badge
 * (`limit-badge.tsx`), which also knows the account's reset.
 */
export function LiveBadge(props: { threadId: string }) {
  const live = useLiveConnection();
  const meta = useThreadMeta(props.threadId);
  const fact = meta && threadLiveFact(meta);
  if (live.staleLabel) return <StatusLabel tone="waiting" label={live.staleLabel} />;
  if (!fact || fact.kind === "limited") return null;
  const status = describeLive(fact, 0);
  return (
    <span role="status">
      <StatusLabel tone={status.tone} label={status.label}>
        {status.code && (
          <>
            {" "}
            <code className="min-w-0 truncate font-mono">{status.code}</code>
          </>
        )}
      </StatusLabel>
    </span>
  );
}
