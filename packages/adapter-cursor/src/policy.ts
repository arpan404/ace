import type { Capabilities } from "@ace/protocol";
import type { LocalAgentOptions } from "@cursor/sdk";

export const cursorCapabilities: Capabilities = {
  approvals: "sandbox-only",
  permissions: {
    modes: ["auto-review", "full-access"],
    nativeAutoReview: true,
    toolGate: false,
    guarantees: [
      {
        mode: "auto-review",
        level: "sandbox",
        gates: { writes: true, network: false, protectedReads: false, shell: true },
        limitations: [
          "SDK 1.0.35 exposes no public approval or escalation decision callback; native decisions cannot be audited by ace.",
          "SandboxOptions exposes only enabled; network and protected-read coverage are unverified.",
          "autoReview uses the classifier only when enabled by the connected backend.",
        ],
      },
    ],
  },
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
  _autoReviewAvailable: boolean,
): Pick<
  LocalAgentOptions,
  "sandboxOptions" | "autoReview" | "enableAgentRetries" | "settingSources" | "subagentInherit"
> {
  return {
    sandboxOptions: { enabled: policy === "restricted" },
    autoReview: policy === "restricted",
    // Forward parent tool-selection headers to Task children and grandchildren.
    ...(policy === "restricted" ? { subagentInherit: {} } : {}),
    // Hidden native retries lack authoritative attempt facts on this surface.
    enableAgentRetries: false,
    // Prevent ambient custom MCP/plugin tools from changing the selected lease policy.
    settingSources: [],
  };
}
