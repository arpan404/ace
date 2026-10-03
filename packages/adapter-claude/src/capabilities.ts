import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { Capabilities } from "@ace/protocol";
export function capabilities(cli: DiscoveryResult): Capabilities {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(cli.version ?? "");
  const version = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
  // The recorded baseline is the only version for which the full tree contract is proven.
  const supported =
    cli.installed &&
    ((version[0] ?? 0) > 2 ||
      (version[0] === 2 &&
        ((version[1] ?? 0) > 1 || (version[1] === 1 && (version[2] ?? 0) >= 286))));
  return {
    steer: false,
    launchOptions: supported ? ["effort"] : [],
    interruptCascades: false,
    resume: supported,
    fork: false,
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "full" : "none",
    planMode: supported,
    tokenUsage: supported,
    imageInput: supported,
    rewindFiles: false,
  };
}
