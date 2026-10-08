import { useThreadMeta } from "@ace/client-react";
import { StatusLabel } from "@/components/status-label.tsx";
import { Dot } from "@/components/ui/dot.tsx";

/**
 * After the title in the header while the thread is held at its account's usage limit: "Limited
 * until 3:20 PM" (with the day when it is further off) in the waiting tone's words, from the
 * thread's own reset, else its account's, else just "Limited" when neither says. It is the
 * header's one status: approvals waiting on the person make the thread needs-you instead, so the
 * two never show together. The words are the sidebar row's (`limitedLabel`).
 */
export function LimitBadge(props: { threadId: string }) {
  const status = useThreadMeta(props.threadId)?.status;
  if (status?.state !== "limited") return null;
  return (
    <span role="status">
      <StatusLabel tone="waiting" label="Limited" mark={<Dot tone="limited" />} />
    </span>
  );
}
