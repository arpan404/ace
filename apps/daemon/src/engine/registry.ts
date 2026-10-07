import type { ProviderAdapter, ProviderBackend } from "@ace/engine-api";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { Capabilities, ProviderKind, AcpIdentity } from "@ace/protocol";
type Entry = {
  source: ProviderAdapter & { close?(): Promise<void> };
  adapter: ProviderAdapter & { close?(): Promise<void> };
  capabilities: Capabilities;
  discovery: DiscoveryResult;
};
export class AdapterRegistry {
  private entries = new Map<ProviderKind, Entry>();
  private backends = new Map<string, Entry>();
  register(adapter: ProviderAdapter & { close?(): Promise<void> }, cli: DiscoveryResult): void {
    if (adapter.provider === "cursor" && adapter.backend === "acp")
      throw new Error("Cursor requires the SDK runtime");
    if (adapter.provider === "cursor" && adapter.backend === undefined)
      adapter = { ...adapter, backend: "cursor-sdk" };
    const entry = {
      adapter,
      source: adapter,
      capabilities: adapter.capabilities(cli),
      discovery: { ...cli },
    };
    this.entries.set(adapter.provider, entry);
    const backend = adapter.backend ?? undefined;
    if (backend) this.backends.set(`${adapter.provider}:${backend}`, entry);
  }
  get(provider: ProviderKind, backend?: ProviderBackend): Entry {
    if (provider === "cursor" && this.entries.get(provider)?.adapter.backend === "cursor-sdk")
      backend = "cursor-sdk";
    const entry = backend
      ? this.backends.get(`${provider}:${backend}`)
      : this.entries.get(provider);
    if (!entry)
      throw new Error(
        `No adapter registered for ${provider}${backend ? ` backend ${backend}; install its original runtime to resume` : ""}`,
      );
    return entry;
  }
  /**
   * Startup rebinds every source to the current daemon's services. Enable-time discovery passes
   * `unboundOnly` so adapters already serving sessions keep their binding.
   */
  bindSessions(
    bind: (adapter: ProviderAdapter) => ProviderAdapter & { close?(): Promise<void> },
    options: { unboundOnly?: boolean } = {},
  ): void {
    for (const entry of new Set([...this.entries.values(), ...this.backends.values()])) {
      if (options.unboundOnly && entry.adapter !== entry.source) continue;
      const original = entry.source;
      const bound = bind(original);
      entry.adapter = {
        ...bound,
        close: async () => {
          await bound.close?.();
          if (bound !== original) await original.close?.();
        },
      };
    }
  }
  async close(): Promise<void> {
    const adapters = new Set(
      [...this.entries.values(), ...this.backends.values()].map(({ adapter }) => adapter),
    );
    const results = await Promise.allSettled([...adapters].map((adapter) => adapter.close?.()));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Adapter shutdown failed");
  }
  has(provider: ProviderKind, identity?: AcpIdentity): boolean {
    const entry = this.entries.get(provider);
    return !!entry && (!identity || entry.adapter.acceptsIdentity?.(identity) === true);
  }
}
