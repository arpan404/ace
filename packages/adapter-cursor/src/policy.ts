import type { Capabilities } from "@ace/protocol";
import type { LocalAgentOptions } from "@cursor/sdk";

const baseCapabilities: Capabilities = {
  approvals: "sandbox-only",
  permissions: {
    modes: ["read-only", "auto-review", "full-access"],
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
  attachmentInput: {
    format: "acp",
    documents: [],
    embeddedContext: false,
    maxInlineBytes: 128 * 1024,
  },
  rewindFiles: false,
};
export function localPolicy(
  policy: "restricted" | "full-access",
  sandboxSupported: boolean,
): Pick<
  LocalAgentOptions,
  "sandboxOptions" | "autoReview" | "enableAgentRetries" | "settingSources" | "subagentInherit"
> {
  return {
    sandboxOptions: { enabled: policy === "restricted" && sandboxSupported },
    autoReview: policy === "restricted" && sandboxSupported,
    // Forward parent tool-selection headers to Task children and grandchildren.
    ...(policy === "restricted" ? { subagentInherit: {} } : {}),
    // Hidden native retries lack authoritative attempt facts on this surface.
    enableAgentRetries: false,
    // Prevent ambient custom MCP/plugin tools from changing the selected lease policy.
    settingSources: [],
  };
}

/** Unknown support must never advertise a sandbox that has not passed SDK admission. */
export function cursorCapabilitiesForSandbox(supported: boolean): Capabilities {
  if (supported) return baseCapabilities;
  return {
    ...baseCapabilities,
    approvals: "none",
    permissions: {
      modes: ["read-only", "full-access"],
      nativeAutoReview: false,
      toolGate: false,
      guarantees: [
        {
          mode: "auto-review",
          level: "tool-selection",
          gates: { writes: true, network: true, protectedReads: false, shell: true },
          limitations: [
            "Limited: SDK sandbox support is unavailable or unverified. Auto-review uses read-only tools; no writes, shell, network, MCP or child tools are enabled.",
            "Read tools can access files outside the workspace. Ask is unavailable because SDK 1.0.35 has no public approval decision callback.",
          ],
        },
      ],
    },
  };
}
export const cursorCapabilities = cursorCapabilitiesForSandbox(false);
export function cursorRestrictedTools(
  policy: "restricted" | "full-access",
  sandboxSupported: boolean,
) {
  return policy === "restricted" && !sandboxSupported
    ? { tools: ["read", "grep", "glob", "ls"] }
    : {};
}
