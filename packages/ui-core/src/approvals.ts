import type { ApprovalOption, Interaction, PermissionMode } from "@ace/protocol";

/*
 * Where an approval stands, as its step's note (IR-2), and which of its options the daemon
 * accepts in a mode (IR-13). Its own module: work-log rows need these on the route, while the
 * review's wording (permission-review.ts) loads with the step detail.
 */

export const reviewModeNames: Record<PermissionMode, string> = {
  "read-only": "Read only",
  ask: "Ask",
  "auto-review": "Auto-review",
  "full-access": "Full access",
};

export interface ApprovalOutcome {
  state: "pending" | "sending" | "approved" | "denied" | "closed";
  tone: "approved" | "denied" | "waiting" | "muted";
  /**
   * "Waiting for your approval", "Approved by you", "Approved by you for this thread",
   * "Denied by you", "Approved by ace · auto-review", "Expired", "Cancelled".
   */
  text: string;
}

const optionKind = (
  interaction: Pick<Interaction, "request">,
  optionId: string,
): ApprovalOption["kind"] | undefined =>
  interaction.request.kind === "approval"
    ? interaction.request.options.find((option) => option.id === optionId)?.kind
    : undefined;

function personAnswer(kind: ApprovalOption["kind"] | undefined): Omit<ApprovalOutcome, "state"> {
  switch (kind) {
    case "allow_session":
      return { tone: "approved", text: "Approved by you for this thread" };
    case "allow_always":
      return { tone: "approved", text: "Always allowed by you" };
    case "deny":
    case "deny_always":
      return { tone: "denied", text: "Denied by you" };
    case "cancel":
      return { tone: "muted", text: "Cancelled by you" };
    default:
      return { tone: "approved", text: "Approved by you" };
  }
}

/**
 * Where an approval stands, as one note on its step (IR-2). `answering` is the option the
 * person just picked on this device, shown at once while the answer travels.
 */
export function approvalOutcome(
  interaction: Pick<Interaction, "state" | "request" | "resolution" | "review" | "autoReviewed">,
  answering?: string,
): ApprovalOutcome {
  const review = interaction.review;
  if (review && review.decision !== "escalate") {
    const mode = reviewModeNames[review.mode].toLowerCase();
    return review.decision === "approve"
      ? { state: "approved", tone: "approved", text: `Approved by ace · ${mode}` }
      : { state: "denied", tone: "denied", text: `Denied by ace · ${mode}` };
  }
  const resolution = interaction.resolution;
  if (resolution?.kind === "approval") {
    const answer = personAnswer(optionKind(interaction, resolution.optionId));
    if (interaction.autoReviewed)
      return {
        state: answer.tone === "denied" ? "denied" : "approved",
        tone: answer.tone,
        text: answer.tone === "denied" ? "Denied by ace" : "Approved by ace",
      };
    return {
      state: answer.tone === "denied" ? "denied" : answer.tone === "muted" ? "closed" : "approved",
      ...answer,
    };
  }
  if (interaction.state === "expired") return { state: "closed", tone: "muted", text: "Expired" };
  if (interaction.state === "cancelled")
    return { state: "closed", tone: "muted", text: "Cancelled" };
  if (interaction.state === "resolved")
    return { state: "approved", tone: "approved", text: "Answered" };
  if (answering !== undefined)
    return { state: "sending", ...personAnswer(optionKind(interaction, answering)) };
  return { state: "pending", tone: "waiting", text: "Waiting for your approval" };
}

/**
 * The approval options the daemon will accept in this mode (IR-13): outside full access it
 * refuses "for this thread" and "always", so they are not offered.
 */
export function offeredOptions(
  options: readonly ApprovalOption[],
  mode: PermissionMode | undefined,
): { options: ApprovalOption[]; hidden: number } {
  if (mode === undefined || mode === "full-access") return { options: [...options], hidden: 0 };
  const offered = options.filter(
    (option) => option.kind !== "allow_session" && option.kind !== "allow_always",
  );
  return { options: offered, hidden: options.length - offered.length };
}

/** Why "always allow" is missing, in this mode. */
export function oneShotNote(mode: PermissionMode): string {
  return `Always-allow isn't available in ${reviewModeNames[mode]}: ace reviews each action.`;
}
