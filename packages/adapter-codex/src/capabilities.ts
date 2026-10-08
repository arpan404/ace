import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
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
    permissionModes: nativePermissionModes("codex"),
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
