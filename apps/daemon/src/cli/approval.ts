import type { Interaction } from "@ace/protocol";
import { CliFailure } from "./output.ts";
export function approval(interaction: Interaction, verb: string, selected: string | undefined) {
  if (interaction.state !== "pending")
    throw new CliFailure("refused", "Interaction is already closed");
  if (interaction.request.kind === "plan_review")
    return { kind: "plan_review", decision: verb === "approve" ? "approve" : "reject" };
  if (interaction.request.kind !== "approval")
    throw new CliFailure("refused", "This interaction requires a question or elicitation answer");
  const choice = interaction.request.options.find((candidate) =>
    selected
      ? candidate.id === selected
      : candidate.kind === (verb === "approve" ? "allow_once" : "deny"),
  );
  if (
    !choice ||
    (verb === "approve"
      ? !choice.kind.startsWith("allow_")
      : !["deny", "deny_always", "cancel"].includes(choice.kind))
  )
    throw new CliFailure("refused", "No matching approval option; specify --option");
  return { kind: "approval", optionId: choice.id };
}
