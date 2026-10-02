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
  capabilities(version?: string): Capabilities;
}
export const baseCapabilities: Capabilities = {
  steer: false,
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
