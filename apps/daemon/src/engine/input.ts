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
) => Promise<{ input: ContentPart[]; diagnostics?: ContextDiagnostic[]; release(): void }>;
