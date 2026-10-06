import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
/** Only 0.159.1 and later are verified against this generated experimental protocol. */
export function codexCapabilities(cli: DiscoveryResult): Capabilities {
  const parts = cli.version
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  const [major = -1, minor = -1, patch = -1] = parts ?? [];
  const supported =
    cli.installed && !!parts && (major > 0 || minor > 159 || (minor === 159 && patch >= 1));
  return {
    steer: supported,
    permissions: {
      modes: supported ? ["read-only", "ask", "auto-review", "full-access"] : [],
      nativeAutoReview: true,
      toolGate: supported,
      guarantees: supported
        ? [
            {
              mode: "ask",
              level: "sandbox",
              gates: { writes: true, network: true, protectedReads: false, shell: true },
              limitations: [
                "Read-only sandbox blocks edits, including shell writes, until a human approves native escalation.",
                "Sandbox-allowed read commands can run without approval; protected reads are not gated.",
              ],
            },
            {
              mode: "auto-review",
              level: "sandbox",
              gates: { writes: true, network: true, protectedReads: false, shell: true },
              limitations: [
                "Workspace writes and sandbox-allowed commands do not request approval.",
                "Secret-file reads inside the workspace aren't gated.",
                "Only surfaced approvals receive ace decisions; native auto_review is disabled.",
              ],
            },
          ]
        : [],
    },
    launchOptions: supported ? ["effort", "serviceTier"] : [],
    interruptCascades: false,
    resume: supported,
    fork: supported,
    forkSubagents: supported,
    sessionOptions: supported,
    forkPoints: supported ? ["turn", "end"] : [],
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "full" : "none",
    planMode: supported,
    tokenUsage: supported,
    imageInput: supported,
    attachmentInput: {
      format: "codex",
      documents: [],
      embeddedContext: false,
      maxInlineBytes: 4 * 1024 * 1024,
    },
    rewindFiles: false,
  };
}
