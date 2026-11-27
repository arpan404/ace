import type { ProviderAdapter, ProviderBackend } from "@ace/engine-api";
import type { DiscoveryResult } from "@ace/provider-kit/discovery";
import type { Capabilities, ProviderKind, AcpIdentity } from "@ace/protocol";
type Entry = {
  source: ProviderAdapter & { close?(): Promise<void> };
  adapter: ProviderAdapter & { close?(): Promise<void> };
  capabilities: Capabilities;
  discovery: DiscoveryResult;
};
/** One entry as an observer sees it: the adapter object went through no copy. */
export interface RegistryEntry {
  provider: ProviderKind;
  backend?: ProviderBackend;
  /** The entry that answers a provider default, as against an older backend registration. */
  current: boolean;
  /** A stable number for the adapter object, so a native view can name it across engines. */
  handle: number;
  adapter: ProviderAdapter & { close?(): Promise<void> };
  capabilities: Capabilities;
  discovery: DiscoveryResult;
}

export class AdapterRegistry {
  private entries = new Map<ProviderKind, Entry>();
  private backends = new Map<string, Entry>();
  private observers = new Set<(entries: readonly RegistryEntry[]) => void>();
  /** One stable handle per adapter object, across registrations and engines. */
  private readonly handles = new WeakMap<object, number>();
  private nextHandle = 1;
  /**
   * Calls `listener` with the current entries now and after every change (E5.1: the native
   * engine's view subscribes here). Returns the unsubscribe; with no listener it does nothing
   * beyond that, so the switch-off path is unchanged.
   */
  observe(listener: (entries: readonly RegistryEntry[]) => void): () => void {
    this.observers.add(listener);
    listener(this.snapshot());
    return () => {
      this.observers.delete(listener);
    };
  }

  private handle(adapter: object): number {
    const known = this.handles.get(adapter);
    if (known !== undefined) return known;
    const handle = this.nextHandle++;
    this.handles.set(adapter, handle);
    return handle;
  }

  /**
   * Every entry, including the older backend registrations a provider's map does not hold. A
   * provider's current entry is marked, because a native view keeps the last entry per key and
   * the older registrations come after it.
   */
  private snapshot(): RegistryEntry[] {
    const entries: RegistryEntry[] = [];
    const seen = new Set<object>();
    const push = (entry: Entry, current: boolean): void => {
      if (seen.has(entry.adapter)) return;
      seen.add(entry.adapter);
      entries.push({
        provider: entry.adapter.provider,
        ...(entry.adapter.backend ? { backend: entry.adapter.backend } : {}),
        current,
        handle: this.handle(entry.adapter),
        adapter: entry.adapter,
        capabilities: entry.capabilities,
        discovery: entry.discovery,
      });
    };
    for (const entry of this.entries.values()) push(entry, true);
    for (const entry of this.backends.values()) push(entry, false);
    return entries;
  }

  private changed(): void {
    if (this.observers.size === 0) return;
    const entries = this.snapshot();
    for (const listener of this.observers) listener(entries);
  }

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
    this.changed();
  }
  /**
   * A later reading of a registered CLI, such as its login once that slower probe ends. It
   * applies only to the CLI the adapter was registered with: same path, same version.
   */
  refreshDiscovery(provider: ProviderKind, cli: DiscoveryResult): void {
    const entry = this.entries.get(provider);
    if (
      !entry ||
      !cli.installed ||
      entry.discovery.path !== cli.path ||
      entry.discovery.version !== cli.version
    )
      return;
    entry.discovery = { ...cli };
    this.changed();
  }
  get(provider: ProviderKind, backend?: ProviderBackend): Entry {
    if (provider === "cursor" && this.entries.get(provider)?.adapter.backend === "cursor-sdk")
      backend = "cursor-sdk";
    const entry = backend
      ? this.backends.get(`${provider}:${backend}`)
      : this.entries.get(provider);
    if (!entry)
      throw new Error(
        "The provider isn't ready yet. Check its connection in Settings and try again.",
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
    this.changed();
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
