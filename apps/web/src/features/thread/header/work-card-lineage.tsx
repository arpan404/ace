import { useSidebarThread, useThreadMeta } from "@ace/client-react";
import { listTreeFacts, threadStatusLabel, treeWorking } from "@ace/ui-core";
import { ArrowBendLeftUpIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { RowButton, RowLabel, RowSub, Section, rowIcon } from "./work-card-parts.tsx";

/**
 * Where a child thread came from: the parent thread it was forked or delegated from, with that
 * thread's status in the same words its sidebar row uses. Only a child thread has one.
 */
export function LineageSection(props: { threadId: string; onClose(): void }) {
  const parentId = useThreadMeta(props.threadId)?.lineage?.parentThreadId;
  const parent = useSidebarThread(parentId ?? "");
  const navigate = useNavigate();
  if (!parentId) return null;
  const status = parent
    ? treeWorking(listTreeFacts(parent))
      ? "Working"
      : threadStatusLabel(parent.status).label
    : undefined;
  const title = parent?.title ?? "Parent thread";
  return (
    <Section label="Lineage" title="Lineage">
      <RowButton
        aria-label={`Open parent thread ${title}${status ? `, ${status}` : ""}`}
        onClick={() => {
          props.onClose();
          void navigate({ to: "/t/$threadId", params: { threadId: parentId } });
        }}
      >
        <ArrowBendLeftUpIcon aria-hidden size={16} className={rowIcon} />
        <RowLabel>{title}</RowLabel>
        {status && <RowSub className="shrink-0">{status}</RowSub>}
      </RowButton>
    </Section>
  );
}
