import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { Capabilities } from "@ace/protocol";
export function capabilities(cli: DiscoveryResult): Capabilities {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    cli.version ?? "",
  );
  const version = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  // The recorded baseline is the only version for which the full tree contract is proven.
  const supported =
    cli.installed &&
    ((version[0] ?? 0) > 2 ||
      (version[0] === 2 &&
        ((version[1] ?? 0) > 1 || (version[1] === 1 && (version[2] ?? 0) >= 286))));
  return {
    steer: false,
    permissionModes: nativePermissionModes("claude"),
    permissions: {
      modes: nativePermissionModes("claude").map((mode) => mode.id),
      permissionModes: nativePermissionModes("claude"),
      nativeAutoReview: true,
      toolGate: supported,
    },
    launchOptions: supported ? ["effort", "serviceTier"] : [],
    interruptCascades: false,
    resume: supported,
    fork: supported,
    sessionOptions: supported,
    forkPoints: supported ? ["item", "end"] : [],
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "full" : "none",
    planMode: supported,
    tokenUsage: supported,
    imageInput: supported,
    attachmentInput: {
      format: "claude",
      documents: supported ? ["application/pdf"] : [],
      embeddedContext: false,
      maxInlineBytes: 4 * 1024 * 1024,
    },
    rewindFiles: false,
  };
}
