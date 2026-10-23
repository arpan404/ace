import type { ProviderKind } from "@ace/protocol";
import { acpAgentBrands, providerIcon, type Brand } from "@ace/ui-core/provider-icons";

/*
 * The agents the site names, taken from the app's own tables so the site never lists an agent
 * ace doesn't support.
 */

export interface Agent {
  brand: Brand;
  label: string;
}

/* The providers ace runs natively, in the order the app lists them. */
const builtInKinds: ProviderKind[] = ["claude", "codex", "cursor", "opencode", "antigravity", "pi"];

export const builtInAgents: Agent[] = builtInKinds.flatMap((provider) => {
  const { brand, label } = providerIcon({ provider });
  return brand ? [{ brand, label }] : [];
});

const shown = new Set<Brand>(builtInAgents.map((agent) => agent.brand));

/* ACP registry agents with a mark, skipping any already shown as built-in. */
export const acpAgents: Agent[] = Object.values(acpAgentBrands)
  .flatMap(({ name, brand }) => (brand && !shown.has(brand) ? [{ brand, label: name }] : []))
  .toSorted((a, b) => a.label.localeCompare(b.label));
