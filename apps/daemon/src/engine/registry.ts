import type { ProviderAdapter } from "@ace/engine-api";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { Capabilities, ProviderKind } from "@ace/protocol";

export class AdapterRegistry {
  private entries = new Map<
    ProviderKind,
    { adapter: ProviderAdapter; capabilities: Capabilities }
  >();
  register(adapter: ProviderAdapter, cli: DiscoveryResult): void {
    this.entries.set(adapter.provider, { adapter, capabilities: adapter.capabilities(cli) });
  }
  get(provider: ProviderKind) {
    const entry = this.entries.get(provider);
    if (!entry) throw new Error(`No adapter registered for ${provider}`);
    return entry;
  }
  has(provider: ProviderKind): boolean {
    return this.entries.has(provider);
  }
}
