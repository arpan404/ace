import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
/** The oldest HTTP generation covered by this adapter's recordings. */
export function supportedVersion(version: string | undefined): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version ?? "");
  if (!parts) return false;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  const patch = Number(parts[3]);
  return major === 1 && (minor > 18 || (minor === 18 && patch >= 33));
}
export function capabilities(cli: DiscoveryResult): Capabilities {
  const supported = cli.installed && supportedVersion(cli.version);
  return {
    steer: false,
    interruptCascades: supported,
    resume: supported,
    fork: supported,
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "partial" : "none",
    planMode: supported,
    tokenUsage: supported,
    imageInput: supported,
    rewindFiles: supported,
  };
}
