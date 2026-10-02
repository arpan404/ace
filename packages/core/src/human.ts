import type { AgentStatus, Interaction } from "@ace/protocol";

/** The same human attention rule governs thread status and notification links. */
export function isActionableInteraction(
  interaction: Pick<Interaction, "state" | "blocking">,
  owner: Pick<AgentStatus, "state"> | undefined,
): boolean {
  return interaction.state === "pending" && (interaction.blocking || owner?.state !== "working");
}
