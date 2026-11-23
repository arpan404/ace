import type { AgentError } from "@ace/core";
import type { Capabilities, ProviderKind, ToolKind } from "@ace/protocol";
import type { Data } from "../data.ts";
export interface AcpQuirks {
  provider: ProviderKind;
  command: string;
  args: string[];
  experimental: boolean;
  clientMeta: Data;
  toolKind(update: Data): ToolKind | undefined;
  classifyError(text: string): AgentError | undefined;
  /**
   * Whether an agent message is only the agent saying the client cancelled its prompt: after
   * ace's own cancel, the thread already says the turn stopped (or went on into a steer).
   */
  cancelNotice(text: string): boolean;
  capabilities(version?: string): Capabilities;
}
export const baseCapabilities: Capabilities = {
  permissionModes: [],
  permissions: { modes: [], permissionModes: [], nativeAutoReview: false, toolGate: true },
  steer: true,
  steeringMode: "interrupt-restart",
  interruptCascades: false,
  resume: false,
  fork: false,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "partial",
  planMode: false,
  tokenUsage: false,
  imageInput: false,
  rewindFiles: false,
};
