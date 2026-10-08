import type { RegistryAgent } from "@ace/protocol";
import { ProviderIcon } from "@/components/ui/provider-icons.tsx";

/** ACP agents use the same mark in the registry, Providers and threads. */
export function AgentIcon(props: { agent: Pick<RegistryAgent, "acpAgentId"> }) {
  return <ProviderIcon provider="acp" acpAgentId={props.agent.acpAgentId} size={16} decorative />;
}
