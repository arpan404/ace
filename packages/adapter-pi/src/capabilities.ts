import type { Capabilities } from "@ace/protocol";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
import { piVersionSupported, type DiscoveryResult } from "@ace/provider-kit/discovery";
import { PiProfile } from "@ace/protocol/pi";
export function piProfile(cli: DiscoveryResult) {
  const supported = cli.installed && piVersionSupported(cli.version);
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
    // Pi has no approval channel: Read-only is its own tool allowlist, Full access its default.
    accessModes: accessModeOffers({ provider: "pi" }),
    permissions: {
      modes: accessModeOffers({ provider: "pi" }).map((offer) => offer.native),
      permissionModes: [],
      nativeAutoReview: false,
      toolGate: false,
    },
    launchOptions: supported ? ["effort"] : [],
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
