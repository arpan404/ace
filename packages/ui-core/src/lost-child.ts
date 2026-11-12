import { z } from "zod";
import type { Interaction } from "@ace/protocol";
import type { ApprovalCopy } from "./approval-copy.ts";

const About = z.object({ threadId: z.string() });

/**
 * The child on another machine a pending request is about, when it is the daemon's request
 * about a child whose pairing is gone (ADR 0099): answering it stops tracking that child.
 */
export function lostChildOf(interaction: Interaction): string | undefined {
  if (interaction.state !== "pending" || interaction.request.kind !== "approval") return undefined;
  for (const entry of interaction.raw) {
    if (entry.type !== "ace.machine.lost" || !("data" in entry)) continue;
    const about = About.safeParse(entry.data);
    if (about.success) return about.data.threadId;
  }
  return undefined;
}

/** What a lost child's row offers: the daemon's sentence, and Stop tracking, which answers it. */
export interface LostChildAsk {
  interactionId: string;
  childThreadId: string;
  /** The daemon's one sentence: its work there may still be running. */
  sentence: string;
  /** The button's word. */
  action: string;
  /** The option's own words, which say its work may still be running, for assistive tech. */
  label: string;
  /** The answer that stops tracking it. */
  optionId: string;
}

/**
 * The row action for a lost child (ADR 0099), on any client: the same request the parent's
 * approval strip shows, answered with its one option. Undefined for any other request.
 */
export function lostChildAsk(interaction: Interaction): LostChildAsk | undefined {
  const childThreadId = lostChildOf(interaction);
  if (childThreadId === undefined || interaction.request.kind !== "approval") return undefined;
  const option = interaction.request.options[0];
  if (!option) return undefined;
  return {
    interactionId: interaction.id,
    childThreadId,
    sentence: interaction.request.title,
    action: "Stop tracking",
    label: option.label,
    optionId: option.id,
  };
}

/**
 * The parent's approval about a lost child, worded as its row: the verb that answers it reads
 * Stop tracking, never Deny, since it stops tracking work that may still be running.
 */
export function lostChildCopy(copy: ApprovalCopy, ask: LostChildAsk): ApprovalCopy {
  return {
    ...copy,
    decisions: copy.decisions.map((decision) =>
      decision.option.id === ask.optionId ? { ...decision, label: ask.action } : decision,
    ),
  };
}
