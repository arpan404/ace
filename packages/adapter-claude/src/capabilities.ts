import { accessModeOffers } from "@ace/provider-kit/access-modes";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { admitsVersion } from "@ace/provider-kit/cli-requirements";
import type { Capabilities } from "@ace/protocol";
export function capabilities(cli: DiscoveryResult): Capabilities {
  // The recorded baseline (ace's minimum) is the oldest version the full tree contract is proven on.
  const supported = cli.installed && admitsVersion("claude", cli.version);
  return {
    steer: supported,
    // A `now` message joins the running turn, but the CLI holds it until the running foreground
    // tool returns: it lands at the next tool boundary. A person's steer backgrounds the tool.
    steerTiming: "after_tool",
    permissionModes: nativePermissionModes("claude"),
    accessModes: accessModeOffers({ provider: "claude" }),
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
      // A user message is an ordered `ContentBlockParam[]` (Agent SDK `SDKUserMessage`).
      interleaved: true,
      maxInlineBytes: 4 * 1024 * 1024,
    },
    rewindFiles: false,
  };
}
