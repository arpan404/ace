import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { PiProfile, PiPermissionMode } from "@ace/protocol/pi";
export function piProfile(cli: DiscoveryResult) {
  const supported = cli.installed && cli.version === "0.85.1";
  return PiProfile.parse({
    version: cli.version ?? "unknown",
    supported,
    rollbackConversation: supported,
    extensionDialogs: supported,
    mcpExtension: supported,
    permissions: supported ? ["unrestricted", "read_only"] : [],
  });
}
export function piCapabilities(cli: DiscoveryResult): Capabilities {
  const supported = piProfile(cli).supported;
  return {
    steer: supported,
    permissions: {
      modes: supported ? ["read-only", "ask", "auto-review", "full-access"] : [],
      nativeAutoReview: false,
      toolGate: false,
      guarantees: supported
        ? [
            {
              mode: "auto-review",
              level: "tool-selection",
              gates: { writes: true, network: true, protectedReads: false, shell: true },
              limitations: [
                "Only read,grep,find,ls tools are enabled; ambient extensions and MCP tools are excluded.",
                "Read tools can access secret files; Pi RPC has no tool permission callback.",
              ],
            },
          ]
        : [],
    },
    interruptCascades: false,
    resume: supported,
    fork: supported,
    subagentTranscripts: false,
    backgroundTaskControl: false,
    backgroundVisibility: "none",
    planMode: false,
    tokenUsage: supported,
    imageInput: supported,
    rewindFiles: false,
  };
}
export function piPermissionArgs(value: PiPermissionMode): string[] {
  const mode = PiPermissionMode.parse(value);
  if (mode === "read_only") return ["--no-extensions", "--tools", "read,grep,find,ls"];
  if (mode === "unrestricted") return [];
  throw new Error(`Pi 0.85.1 cannot enforce ${mode} permissions`);
}
