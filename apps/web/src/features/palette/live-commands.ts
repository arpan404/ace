import {
  ArrowBendDownRightIcon,
  CheckIcon,
  CpuIcon,
  GaugeIcon,
  ProhibitIcon,
  StopIcon,
} from "@phosphor-icons/react";
import { useInteraction, useInteractions, useIntentSender } from "@ace/client-react";
import { InteractionId, type Interaction } from "@ace/protocol";
import { approvalCopy } from "@ace/ui-core";
import { useParams } from "@tanstack/react-router";
import { useThreadSteps } from "@/features/home/index.ts";
import { keymap } from "@/lib/keymap.ts";
import { useLayout } from "@/lib/layout.tsx";
import type { PaletteCommand, PaletteGroup } from "./types.ts";

const isApproval = (interaction: Interaction) =>
  interaction.state === "pending" && interaction.request.kind === "approval";

const verbIcons = { allow_once: CheckIcon, always_allow: CheckIcon, deny: ProhibitIcon } as const;
const verbWords = {
  allow_once: "approve accept yes",
  always_allow: "approve accept yes always",
  deny: "reject decline no",
} as const;

/** The open thread's oldest approval, answered in the same verbs its card offers. */
function useApprovalCommands(threadId: string | undefined, close: () => void): PaletteCommand[] {
  const ids = useInteractions(threadId, isApproval);
  const id = ids?.[0] ?? "";
  const interaction = useInteraction(threadId, id);
  const sender = useIntentSender();
  const request = interaction?.request;
  if (!threadId || !interaction || request?.kind !== "approval") return [];
  const copy = approvalCopy(request, { review: interaction.review });
  const about = copy.command ?? copy.heading;
  return copy.decisions.map((decision): PaletteCommand => ({
    id: `approval-${decision.verb}`,
    label: decision.label,
    detail: about,
    keywords: verbWords[decision.verb],
    icon: verbIcons[decision.verb],
    danger: decision.verb === "deny",
    run: () => {
      close();
      void sender
        .send({
          type: "interaction.resolve",
          interactionId: InteractionId.parse(interaction.id),
          resolution: { kind: "approval", optionId: decision.option.id },
        })
        .catch(() => {});
    },
  }));
}

/**
 * What acts on the open thread's agent right now: Stop, its pending approval, the model and its
 * effort, and the next thread that needs the person. Typed words ("stop", "approve", "model",
 * "effort") find them.
 */
export function useLiveCommands(close: () => void): PaletteGroup[] {
  const current = useParams({ strict: false }).threadId;
  const { composerActions } = useLayout();
  const steps = useThreadSteps();
  const approvals = useApprovalCommands(current, close);
  const composer = composerActions?.scope === current ? composerActions : undefined;
  const run = (action: () => void) => () => {
    close();
    action();
  };
  const items: PaletteCommand[] = [];
  if (composer?.stop)
    items.push({
      id: "stop-agent",
      label: "Stop the agent",
      keywords: "stop interrupt halt cancel",
      icon: StopIcon,
      danger: true,
      run: run(composer.stop),
    });
  items.push(...approvals);
  if (composer)
    items.push(
      {
        id: "switch-model",
        label: "Switch model…",
        keywords: "model change provider",
        icon: CpuIcon,
        run: run(composer.chooseModel),
      },
      {
        id: "change-effort",
        label: "Change effort…",
        keywords: "effort reasoning thinking",
        icon: GaugeIcon,
        run: run(composer.tuneEffort),
      },
    );
  if (steps.othersNeedYou)
    items.push({
      id: "next-needs-you",
      label: "Next thread that needs you",
      keywords: "needs you waiting approval question",
      keys: keymap.nextNeedsYou.keys,
      icon: ArrowBendDownRightIcon,
      run: run(steps.nextNeedsYou),
    });
  return items.length ? [{ value: "Agent", items }] : [];
}
