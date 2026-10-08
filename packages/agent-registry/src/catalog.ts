import type { RegistryAgent } from "@ace/protocol";
import {
  availability,
  decodeIndex,
  limits,
  publicUrl,
  REGISTRY_URL,
  runtimes,
  type AgentEntry,
  type RegistryIndex,
} from "./decode.ts";
import {
  boundedBody,
  digest,
  validateSnapshot,
  type RegistryCache,
  type Snapshot,
} from "./cache.ts";
import { matchProfile } from "./profiles.ts";
export type CatalogOptions = {
  cache: RegistryCache;
  now(): number;
  source?: string;
  target: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};
export class AgentCatalog {
  readonly #options: CatalogOptions;
  #snapshot: Snapshot | undefined;
  #index: RegistryIndex | undefined;
  #entries = new Map<string, AgentEntry>();
  #flight: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #error: "refresh_failed" | "cache_failed" | undefined;
  #closed = false;
  private constructor(options: CatalogOptions) {
    this.#options = options;
  }
  static async open(options: CatalogOptions): Promise<AgentCatalog> {
    const catalog = new AgentCatalog(options);
    try {
      const value = await options.cache.load();
      if (value !== undefined) {
        const { snapshot, index } = validateSnapshot(value, options.source ?? REGISTRY_URL);
        catalog.#adopt(snapshot, index);
      }
    } catch {
      catalog.#error = "cache_failed";
    }
    return catalog;
  }
  #adopt(snapshot: Snapshot, index: RegistryIndex): void {
    this.#snapshot = snapshot;
    this.#index = index;
    this.#entries = new Map(index.agents.map((agent) => [this.agentId(agent.id), agent]));
    this.#error = undefined;
  }
  agentId(id: string): string {
    return this.#options.source && this.#options.source !== REGISTRY_URL
      ? `registry-${digest(this.#options.source).slice(0, 16)}:${id}`
      : `official:${id}`;
  }
  entry(id: string): AgentEntry | undefined {
    const entry = this.#entries.get(id);
    return entry ? structuredClone(entry) : undefined;
  }
  get source(): string {
    return this.#options.source ?? REGISTRY_URL;
  }
  get contentDigest(): string | undefined {
    return this.#snapshot?.digest;
  }
  list(offset = 0, limit = 50) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > limits.entries ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("Invalid registry page");
    const agents: RegistryAgent[] = (this.#index?.agents ?? [])
      .slice(offset, offset + limit)
      .map((agent) => {
        const profile =
          this.source === REGISTRY_URL ? matchProfile(agent.id, agent.version) : undefined;
        const listed: RegistryAgent = {
          acpAgentId: this.agentId(agent.id),
          name: agent.name,
          version: agent.version,
          description: agent.description,
          source: this.source,
          authors: [...agent.authors],
          availability: availability(agent, this.#options.target),
          coverage: profile ? "source_profile" : "generic",
          auth: "unknown",
          loginHint: profile?.loginHint ?? "Use the agent CLI's own login or configuration command",
          visibility: "limited",
          isolation: "unsupported",
          runtimes: runtimes(agent, this.#options.target),
        };
        return Object.assign(listed, links(agent));
      });
    return {
      ok: true as const,
      agents,
      source: this.source,
      stale: !this.#snapshot || this.#options.now() - this.#snapshot.fetchedAt >= limits.ttl,
      refreshing: Boolean(this.#flight),
      ...(this.#snapshot
        ? {
            digest: this.#snapshot.digest,
            fetchedAt: this.#snapshot.fetchedAt,
            schemaVersion: this.#snapshot.schemaVersion,
            ...(this.#snapshot.release ? { release: this.#snapshot.release } : {}),
          }
        : {}),
      ...(this.#error ? { error: this.#error } : {}),
      ...((this.#index?.agents.length ?? 0) > offset + limit ? { nextOffset: offset + limit } : {}),
    };
  }
  refresh(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Registry closed"));
    if (this.#flight) return this.#flight;
    const abort = new AbortController();
    this.#abort = abort;
    const timer = setTimeout(() => abort.abort(), this.#options.timeoutMs ?? 10000);
    const flight = (async () => {
      try {
        const source = new URL(this.source);
        if (source.protocol !== "https:" || source.username || source.password)
          throw new Error("Registry source must be HTTPS");
        const response = await (this.#options.fetch ?? fetch)(source, {
          signal: abort.signal,
          redirect: "error",
          headers: this.#snapshot?.etag ? { "If-None-Match": this.#snapshot.etag } : {},
        });
        let snapshot: Snapshot;
        let index: RegistryIndex;
        if (response.status === 304 && this.#snapshot && this.#index) {
          snapshot = { ...this.#snapshot, fetchedAt: this.#options.now() };
          index = this.#index;
        } else {
          if (!response.ok) throw new Error("Registry fetch failed");
          const bytes = await boundedBody(response, limits.response, abort.signal);
          index = decodeIndex(bytes);
          const etag = response.headers.get("etag");
          const release = response.headers.get("x-registry-release");
          snapshot = {
            source: this.source,
            schemaVersion: index.version,
            fetchedAt: this.#options.now(),
            digest: digest(bytes),
            body: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            ...(etag && etag.length <= 1024 ? { etag } : {}),
            ...(release && release.length <= 256 ? { release } : {}),
          };
        }
        abort.signal.throwIfAborted();
        await this.#options.cache.save(snapshot);
        if (!this.#closed) this.#adopt(snapshot, index);
      } catch {
        this.#error = "refresh_failed";
      } finally {
        clearTimeout(timer);
        this.#abort = undefined;
        this.#flight = undefined;
      }
    })();
    this.#flight = flight;
    return flight;
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#abort?.abort();
    await this.#flight;
  }
}
/** The entry's icon, homepage and license, when upstream gives usable ones. */
function links(agent: AgentEntry): Pick<RegistryAgent, "icon" | "homepage" | "license"> {
  const icon = publicUrl(agent.icon);
  const homepage = publicUrl(agent.website) ?? publicUrl(agent.repository);
  return {
    ...(icon ? { icon } : {}),
    ...(homepage ? { homepage } : {}),
    ...(agent.license ? { license: agent.license } : {}),
  };
}
