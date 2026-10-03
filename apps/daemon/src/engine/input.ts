import type { Command, ContentPart, ProviderKind, Capabilities } from "@ace/protocol";
export type PrepareInput = (
  command: Command,
  provider: ProviderKind,
  capabilities: Capabilities,
) => Promise<{ input: ContentPart[]; release(): void }>;
