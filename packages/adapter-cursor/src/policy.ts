import type { Capabilities } from "@ace/protocol";
import type { LocalAgentOptions } from "@cursor/sdk";

export const cursorCapabilities: Capabilities = {
  approvals: "sandbox-only",
  steeringMode: "interrupt-restart",
  forkMode: "context-handoff",
  childControls: "read-only",
  childFidelity: "summary",
  steer: true,
  interruptCascades: true,
  resume: true,
  fork: true,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "partial",
  planMode: false,
  tokenUsage: true,
  imageInput: true,
  rewindFiles: false,
};
export function localPolicy(
  policy: "restricted" | "full-access",
  autoReviewAvailable: boolean,
): Pick<
  LocalAgentOptions,
  "sandboxOptions" | "autoReview" | "enableAgentRetries" | "settingSources"
> {
  if (policy === "restricted" && !autoReviewAvailable)
    throw new Error(
      "Cursor Auto-review availability is unverified. Confirm classifier availability before restricted execution; policy was not downgraded.",
    );
  return {
    sandboxOptions: { enabled: policy === "restricted" },
    autoReview: policy === "restricted",
    // Hidden native retries lack authoritative attempt facts on this surface.
    enableAgentRetries: false,
    // Prevent ambient custom MCP/plugin tools from changing the selected lease policy.
    settingSources: [],
  };
}
