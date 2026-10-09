import { useSidebarThread } from "@ace/client-react";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { StatusLabel } from "@/components/status-label.tsx";
import { CompactViewRowBody, compactViewRowClass } from "@/components/ui/view-row.tsx";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { recoveryAttention, useFailedSendThreads } from "./recovery-attention.ts";

/** The same recovery row in the desktop detail and the mobile inbox. */
export function RecoveryThreadRow(props: { threadId: string }) {
  const thread = useSidebarThread(props.threadId);
  const models = useModelCatalog();
  const failed = useFailedSendThreads();
  const attention = thread && recoveryAttention(thread, models, failed);
  if (!thread || !attention) return null;
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      aria-label={`${thread.title}: ${attention}`}
      className={compactViewRowClass}
      data-view-row=""
    >
      <CompactViewRowBody
        icon={WarningCircleIcon}
        title={thread.title}
        status={<StatusLabel tone="needs-you" label={attention} />}
      />
    </Link>
  );
}
