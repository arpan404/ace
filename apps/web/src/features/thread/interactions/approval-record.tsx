import { useInteraction, useItem } from "@ace/client-react";
import { approvalOutcome, approvalRecordLabel, displayCommand } from "@ace/ui-core";
import { Dot } from "@/components/ui/dot.tsx";

/**
 * A decided approval's place in history when it has no tool call row to read on; the attached
 * card owns every button. One withdrawn or timed out without the person's answer leaves no row.
 */
export function ApprovalRecord(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const item = useItem(props.threadId, interaction?.toolCallId ?? "");
  const label = interaction && approvalRecordLabel(interaction);
  if (!interaction || label === undefined) return null;
  const outcome = approvalOutcome(interaction);
  const command =
    item?.type === "tool_call" && item.call.detail.kind === "shell"
      ? displayCommand(item.call.detail).command
      : undefined;
  return (
    <p role="note" className="flex min-w-0 items-center gap-2 py-1 text-xs text-muted-foreground">
      <Dot
        tone={outcome.tone === "denied" ? "failed" : outcome.state === "approved" ? "done" : "idle"}
      />
      <span>
        {label}
        {command ? ":" : ""}
      </span>
      {command && <code className="min-w-0 truncate">{command}</code>}
    </p>
  );
}
