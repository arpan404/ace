import type {
  Command,
  ContentPart,
  ProviderKind,
  Capabilities,
  ContextDiagnostic,
} from "@ace/protocol";
export type PrepareInput = (
  command: Command,
  provider: ProviderKind,
  capabilities: Capabilities,
) => Promise<{
  input: ContentPart[];
  attachments?: import("@ace/protocol").Attachment[];
  attachmentPaths?: { sha256: string; path: string }[];
  diagnostics?: ContextDiagnostic[];
  release(): void;
}>;
