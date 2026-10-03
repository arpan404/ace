import type { ProviderAdapter } from "@ace/engine-api";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { Capabilities, ProviderKind } from "@ace/protocol";

export class AdapterRegistry {
  private entries = new Map<
    ProviderKind,
    { adapter: ProviderAdapter & { close?(): Promise<void> }; capabilities: Capabilities }
  >();
  register(adapter: ProviderAdapter & { close?(): Promise<void> }, cli: DiscoveryResult): void {
    this.entries.set(adapter.provider, { adapter, capabilities: adapter.capabilities(cli) });
  }
  get(provider: ProviderKind) {
    const entry = this.entries.get(provider);
    if (!entry) throw new Error(`No adapter registered for ${provider}`);
    return entry;
  }
  bindSessions(bind: (adapter: ProviderAdapter) => ProviderAdapter): void {
    for (const entry of this.entries.values()) {
      const original = entry.adapter;
      const bound = bind(original);
      entry.adapter = {
        ...bound,
        ...(original.close ? { close: () => original.close?.() ?? Promise.resolve() } : {}),
      };
    }
  }
  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.entries.values()].map(({ adapter }) => adapter.close?.()),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Adapter shutdown failed");
  }
  has(provider: ProviderKind): boolean {
    return this.entries.has(provider);
  }
}
