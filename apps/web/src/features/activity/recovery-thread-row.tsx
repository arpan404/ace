import { useSidebarThread } from "@ace/client-react";
import { rowAttention } from "@ace/ui-core";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { StatusLabel } from "@/components/status-label.tsx";
import { CompactViewRowBody, compactViewRowClass } from "@/components/ui/view-row.tsx";
import { useModelCatalog } from "@/lib/model-catalog.ts";
import { recoveryAttention, useFailedSendThreads } from "./recovery-attention.ts";

/**
 * The same recovery row in the desktop detail and the mobile inbox. Its word and colour come
 * from the rule the thread's sidebar row reads (`rowAttention`), so the two always agree.
 */
export function RecoveryThreadRow(props: { threadId: string }) {
  const thread = useSidebarThread(props.threadId);
  const models = useModelCatalog();
  const failed = useFailedSendThreads();
  const recovery = thread && recoveryAttention(thread, models, failed);
  if (!thread || !recovery) return null;
  const attention = rowAttention({
    tone: recovery.tone,
    word: recovery.label,
    unread: thread.unread === true,
    settled: false,
    recovery: true,
  });
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      aria-label={`${thread.title}: ${recovery.label}`}
      className={compactViewRowClass}
      data-view-row=""
      data-attention={attention.level}
    >
      <CompactViewRowBody
        icon={WarningCircleIcon}
        title={thread.title}
        status={<StatusLabel tone={attention.tone} label={attention.word ?? recovery.label} />}
      />
    </Link>
  );
}
