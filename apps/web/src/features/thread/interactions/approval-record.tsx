import { useInteraction, useItem } from "@ace/client-react";
import { approvalOutcome, displayCommand, requestIdentity } from "@ace/ui-core";
import { Dot } from "@/components/ui/dot.tsx";
import { useLocalAnswer } from "./answers.ts";

/** An approval's place in history once decided; the attached card owns every button. */
export function ApprovalRecord(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const item = useItem(props.threadId, interaction?.toolCallId ?? "");
  const local = useLocalAnswer(
    props.interactionId,
    interaction ? requestIdentity(interaction) : undefined,
  );
  if (!interaction || interaction.request.kind !== "approval") return null;
  const outcome = approvalOutcome(interaction);
  const command =
    item?.type === "tool_call" && item.call.detail.kind === "shell"
      ? displayCommand(item.call.detail).command
      : undefined;
  const resolution = interaction.resolution ?? local?.resolution;
  const option =
    resolution?.kind === "approval"
      ? interaction.request.options.find((choice) => choice.id === resolution.optionId)
      : undefined;
  const label =
    option?.kind === "allow_once"
      ? "Allowed once"
      : option?.kind === "deny"
        ? "Denied"
        : option?.kind === "allow_always"
          ? "Always allowed"
          : outcome.text;
  // While it waits, the turn's live head says so and the card above the composer asks: once
  // per turn. The record takes its place in history once decided.
  if (interaction.state === "pending") return null;
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
