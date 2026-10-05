import { useAgent, useItem } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { describeStep, type StepText } from "@ace/ui-core";
import { useChangesStat } from "@/lib/diffs/use-file-diffs.ts";
import { usePendingAnswer } from "../interactions/pending-answers.ts";
import { useStepLabels } from "./step-labels.ts";
import { useItemInteraction } from "../interactions/use-item-interaction.ts";

/**
 * One work-log step as its row reads it: paths relative to where its agent works (IR-6), the
 * readable command (IR-5), what a failure was (A4), and the approval that gated it as the row's
 * note, the person's pick shown at once (IR-2).
 */
export function useStepDisplay(
  threadId: string,
  itemId: string,
): { item: Item; step: StepText; awaiting: boolean } | undefined {
  const item = useItem(threadId, itemId);
  const agent = useAgent(threadId, item?.agentId ?? "");
  const interaction = useItemInteraction(threadId, item?.type === "tool_call" ? itemId : "");
  const pending = usePendingAnswer(interaction?.id);
  const labels = useStepLabels();
  const answering = pending?.kind === "approval" ? pending.optionId : undefined;
  const described =
    item &&
    describeStep(item, {
      cwd: agent?.cwd,
      interaction: interaction?.request.kind === "approval" ? interaction : undefined,
      answering,
      labels,
    });
  // A full-text edit's stat is a text diff, counted in the diff worker rather than here.
  const counted = useChangesStat(described?.diffFor);
  if (!item || !described) return undefined;
  // Without its interaction loaded, the provider's own status says whether it waits.
  const awaiting =
    described.needsYou ?? (item.type === "tool_call" && item.call.status === "awaiting_approval");
  const step = counted ? { ...described, ...counted } : described;
  return { item, step, awaiting };
}
