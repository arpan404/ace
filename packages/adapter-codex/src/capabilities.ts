import { accessModeOffers } from "@ace/provider-kit/access-modes";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { admitsVersion } from "@ace/provider-kit/cli-requirements";
/** Only ace's minimum and later are verified against this generated experimental protocol. */
export function codexCapabilities(cli: DiscoveryResult): Capabilities {
  const supported = cli.installed && admitsVersion("codex", cli.version);
  return {
    steer: supported,
    // `turn/steer` lands at the next model request, after the running command returns.
    steerTiming: "after_tool",
    permissionModes: nativePermissionModes("codex"),
    accessModes: accessModeOffers({ provider: "codex" }),
    permissions: {
      modes: nativePermissionModes("codex").map((mode) => mode.id),
      permissionModes: nativePermissionModes("codex"),
      nativeAutoReview: true,
      toolGate: supported,
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
    goals: supported,
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
