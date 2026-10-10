import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { version } from "./boundaries.ts";
export const supportedVersion = version;
export function capabilities(cli: DiscoveryResult): Capabilities {
  const supported = cli.installed && version(cli.version);
  return {
    steer: supported,
    sessionOptions: supported,
    launchOptions: supported ? ["effort"] : [],
    permissionModes: nativePermissionModes("opencode"),
    permissions: {
      modes: nativePermissionModes("opencode").map((mode) => mode.id),
      permissionModes: nativePermissionModes("opencode"),
      nativeAutoReview: false,
      toolGate: supported,
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
    attachmentInput: {
      format: "opencode",
      documents: [],
      embeddedContext: false,
      maxInlineBytes: 4 * 1024 * 1024,
    },
    rewindFiles: false,
  };
}
