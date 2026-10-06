import type { AgentError } from "@ace/core";
import type { Capabilities, ProviderKind, ToolKind } from "@ace/protocol";
import type { Data } from "../data.ts";
export interface AcpQuirks {
  provider: ProviderKind;
  command: string;
  args: string[];
  experimental: boolean;
  clientMeta: Data;
  toolKind(update: Data): ToolKind | undefined;
  classifyError(text: string): AgentError | undefined;
  capabilities(version?: string): Capabilities;
}
export const baseCapabilities: Capabilities = {
  permissions: {
    modes: ["auto-review", "full-access"],
    nativeAutoReview: false,
    toolGate: true,
    guarantees: [
      {
        mode: "auto-review",
        level: "permission-requests",
        gates: { writes: false, network: false, protectedReads: false, shell: false },
        limitations: [
          "ACP does not guarantee permission request coverage; unsurfaced operations receive no ace review.",
          "Advertised read-only/plan selectors are selected when present; ACP provides no portable tool allowlist or sandbox.",
          "Client filesystem and terminal operations are disabled.",
          "Read categories and follow-along locations do not prove exact file access; generic reads require a human decision.",
        ],
      },
    ],
  },
  steer: false,
  interruptCascades: false,
  resume: false,
  fork: false,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "partial",
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
};
