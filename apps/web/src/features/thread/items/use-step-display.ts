import { useAgent } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { describeStep, shownStep, type StepText } from "@ace/ui-core";
import type { AceToolContext } from "@ace/ui-core/ace-tools";
import { useChangesStat } from "@/lib/diffs/use-file-diffs.ts";
import { usePendingAnswer } from "../interactions/pending-answers.ts";
import { useStepLabels } from "./step-labels.ts";
import { useItemInteraction } from "../interactions/use-item-interaction.ts";
import { useStepItem } from "./step-items.ts";

/**
 * One work-log step as its row reads it: paths relative to where its agent works (IR-6), the
 * readable command (IR-5), what a failure was (A4), and the approval that gated it as the row's
 * note, the person's pick shown at once (IR-2).
 */
export function useStepDisplay(
  threadId: string,
  itemId: string,
  /** What earlier steps of its log say about it, for ace's own tools. */
  ace?: AceToolContext,
): { item: Item; step: StepText; awaiting: boolean } | undefined {
  const item = useStepItem(threadId, itemId);
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
      ace,
    });
  // A full-text edit's stat is a text diff, counted in the diff worker rather than here.
  const counted = useChangesStat(described?.diffFor);
  if (!item || !described) return undefined;
  const shown = shownStep(item, described, counted);
  return { item, ...shown };
}
