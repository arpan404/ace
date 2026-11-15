import type { Interaction, InteractionResolution } from "@ace/protocol";
import { answerRefusal, sentSummarized } from "@ace/projection/interaction-summary";

/*
 * A request the daemon sends summarized (ADR 0156) is never read whole on the phone, so the
 * phone never answers yes to it: its rows offer only declines and say why, and an affirmative
 * answer that reaches the bridge anyway is dropped before it is saved. The rules for which
 * answers are affirmative and which requests go summarized are `@ace/projection`'s.
 */

const verbs: Partial<Record<Interaction["request"]["kind"], string>> = {
  approval: "approve",
  plan_review: "approve",
  question: "answer",
  elicitation: "answer",
};

/** What a summarized request's card says, or "" for one the phone got whole. */
export function summarizedNote(interaction: Interaction): string {
  const verb = verbs[interaction.request.kind];
  if (!verb || !sentSummarized(interaction)) return "";
  return `This request is too large to review on the phone. Open it on your computer to ${verb} it.`;
}

/** `interaction` with only the approval options that decline, when it went summarized. */
export function declinesOnly(interaction: Interaction): Interaction {
  const request = interaction.request;
  if (request.kind !== "approval" || !sentSummarized(interaction)) return interaction;
  return {
    ...interaction,
    request: {
      ...request,
      options: request.options.filter((option) => !option.kind.startsWith("allow")),
    },
  };
}

/** `resolution`, unless it says yes to a request the phone never read whole. */
export function phoneAnswer<R extends InteractionResolution>(
  interaction: Interaction,
  resolution: R | undefined,
): R | undefined {
  if (!resolution) return undefined;
  return answerRefusal(interaction, resolution, false) ? undefined : resolution;
}
