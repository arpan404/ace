import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { PiProfile } from "@ace/protocol/pi";
export function piProfile(cli: DiscoveryResult) {
  const supported = cli.installed && cli.version === "0.85.1";
  return PiProfile.parse({
    version: cli.version ?? "unknown",
    supported,
    rollbackConversation: supported,
    extensionDialogs: supported,
    mcpExtension: supported,
    permissions: [],
  });
}
export function piCapabilities(cli: DiscoveryResult): Capabilities {
  const supported = piProfile(cli).supported;
  return {
    steer: supported,
    permissionModes: [],
    permissions: { modes: [], permissionModes: [], nativeAutoReview: false, toolGate: false },
    interruptCascades: false,
    resume: supported,
    fork: supported,
    subagentTranscripts: false,
    backgroundTaskControl: false,
    backgroundVisibility: "none",
    planMode: false,
    tokenUsage: supported,
    imageInput: supported,
    attachmentInput: {
      format: "acp",
      documents: [],
      embeddedContext: false,
      maxInlineBytes: 128 * 1024,
    },
    rewindFiles: false,
  };
}
