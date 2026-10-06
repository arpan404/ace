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
      toolGate: supported,
      guarantees: supported
        ? (["ask", "auto-review"] as const).map((mode) => ({
            mode,
            level: "tool-gate",
            gates: { writes: true, network: true, protectedReads: true, shell: true },
            limitations: [
              "The ace extension gates each selected tool before execution using Pi tool_call and RPC confirmation. Ambient extensions are excluded.",
              "Pi is not an OS sandbox. Approved shell commands and tools retain the provider process permissions; unknown effects require a human.",
            ],
          }))
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
