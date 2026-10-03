import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { version } from "./boundaries.ts";
export const supportedVersion = version;
export function capabilities(cli: DiscoveryResult): Capabilities {
  const supported = cli.installed && version(cli.version);
  return {
    steer: supported,
    permissions: {
      modes: supported ? ["read-only", "ask", "auto-review", "full-access"] : [],
      nativeAutoReview: false,
      toolGate: supported,
      guarantees: supported
        ? [
            {
              mode: "auto-review",
              level: "tool-gate",
              gates: { writes: true, network: true, protectedReads: true, shell: true },
              limitations: [
                "Wildcard ask rules gate tools; incomplete permission targets escalate to the user.",
              ],
            },
          ]
        : [],
    },
    interruptCascades: supported,
    resume: supported,
    fork: false,
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "full" : "none",
    planMode: false,
    tokenUsage: supported,
    imageInput: supported,
    rewindFiles: false,
  };
}
