import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
/** Only 0.159.1 and later are verified against this generated experimental protocol. */
export function codexCapabilities(cli: DiscoveryResult): Capabilities {
  const parts = cli.version
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  const supported =
    cli.installed &&
    !!parts &&
    (parts[0]! > 0 || parts[1]! > 159 || (parts[1] === 159 && parts[2]! >= 1));
  return {
    steer: supported,
    interruptCascades: false,
    resume: supported,
    fork: supported,
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "full" : "none",
    planMode: supported,
    tokenUsage: supported,
    imageInput: supported,
    rewindFiles: false,
  };
}
