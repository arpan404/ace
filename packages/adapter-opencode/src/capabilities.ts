import type { Capabilities } from "@ace/protocol";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import { version } from "./boundaries.ts";
export const supportedVersion = version;
export function capabilities(cli: DiscoveryResult): Capabilities {
  const supported = cli.installed && version(cli.version);
  return {
    steer: supported,
    interruptCascades: supported,
    resume: supported,
    fork: false,
    subagentTranscripts: supported,
    backgroundTaskControl: supported,
    backgroundVisibility: supported ? "full" : "none",
    planMode: false,
    tokenUsage: supported,
    imageInput: supported,
    rewindFiles: false,
  };
}
