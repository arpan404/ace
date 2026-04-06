import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary =
    approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "file-read"
        ? "File-read approval requested"
        : "File-change approval requested";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-semibold tracking-[0.18em] text-amber-500 uppercase">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
          </span>
          Approval
        </span>
        <span className="text-[13px] font-medium text-foreground/85">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="flex h-[18px] items-center rounded-full bg-muted/40 px-2 text-[10px] font-semibold tabular-nums text-muted-foreground/60">
            1/{pendingCount}
          </span>
        ) : null}
      </div>
    </div>
  );
});
