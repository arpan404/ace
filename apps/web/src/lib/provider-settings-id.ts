import type { ProviderKind } from "@ace/protocol";

/** Account labels can differ from registry names; linked ACP installs share their identity. */
export function providerSettingsId(
  provider: ProviderKind,
  name: string,
  acpAgentId?: string,
): string {
  return provider === "acp" ? `acp:${acpAgentId ?? name}` : provider;
}
