import { useThreadMeta } from "@ace/client-react";
import { limitedLabel } from "@ace/ui-core";
import { StatusLabel } from "@/components/status-label.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { useNow } from "@/lib/time.ts";
import { useThreadReset } from "../lib/thread-account.ts";

/**
 * After the title in the header while the thread is held at its account's usage limit: "Limited
 * until 3:20 PM" (with the day when it is further off) in the waiting tone's words, from the
 * thread's own reset, else its account's, else just "Limited" when neither says. It is the
 * header's one status: approvals waiting on the person make the thread needs-you instead, so the
 * two never show together. The words are the sidebar row's (`limitedLabel`).
 */
export function LimitBadge(props: { threadId: string }) {
  const status = useThreadMeta(props.threadId)?.status;
  const until = useThreadReset(props.threadId);
  const now = useNow();
  if (status?.state !== "limited") return null;
  return (
    <span role="status">
      <StatusLabel tone="waiting" label={limitedLabel(until, now)} mark={<Dot tone="limited" />} />
    </span>
  );
}
