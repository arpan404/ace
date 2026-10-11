import { PluginRequest, PluginResponse } from "@ace/protocol/plugins";
import type { PluginManager } from "./manager.ts";

/** Standalone validated command boundary for the daemon command owner to mount. */
export class PluginService {
  private readonly manager: PluginManager;
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(manager: PluginManager) {
    this.manager = manager;
  }
  private readonly listeners = new Set<() => void>();
  subscribeCatalog(listener: () => void): () => void {
    if (this.stopped || this.listeners.size >= 64) throw new Error("Plugin catalog listener limit");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  extensions(provider: import("@ace/protocol").ProviderKind) {
    return this.admit(() => this.manager.extensions(provider));
  }
  handle(input: unknown): Promise<PluginResponse> {
    return this.admit(() => this.publish(input));
  }
  private admit<T>(run: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Plugin service closed"));
    if (this.pending.size >= 64) return Promise.reject(new Error("Plugin service busy"));
    const work = Promise.resolve().then(run);
    this.pending.add(work);
    return work.finally(() => {
      this.pending.delete(work);
    });
  }
  stopAdmission(): void {
    this.stopped = true;
    this.listeners.clear();
  }
  close(): Promise<void> {
    this.stopAdmission();
    this.closing ??= Promise.allSettled(this.pending).then(() => this.manager.close());
    return this.closing;
  }
  private async publish(input: unknown): Promise<PluginResponse> {
    const result = await this.respond(input);
    if (
      [
        "plugins.availability",
        "plugins.skillAvailability",
        "plugins.accept",
        "plugins.remove",
      ].includes(PluginRequest.parse(input).type)
    )
      for (const listener of this.listeners) listener();
    return result;
  }
  private async respond(input: unknown): Promise<PluginResponse> {
    const request = PluginRequest.parse(input);
    switch (request.type) {
      case "plugins.skillAvailability":
        return PluginResponse.parse({
          type: "plugins.skillAvailability",
          availability: await this.manager.configureSkill(request),
        });
      case "plugins.availability":
        return PluginResponse.parse({
          type: "plugins.availability",
          availability: this.manager.configure(request),
        });
      case "plugins.catalog":
        return PluginResponse.parse({
          type: "plugins.catalog",
          ...(await this.manager.catalog(request.offset, request.limit)),
        });
      case "plugins.source":
        return PluginResponse.parse({
          type: "plugins.source",
          ...(await this.manager.source(request.name, request.path, request.offset, request.limit)),
        });
      case "plugins.edit":
        return PluginResponse.parse({
          type: "plugins.review",
          review: await this.manager.edit(request),
        });
      case "plugins.prepare":
        return PluginResponse.parse({
          type: "plugins.review",
          review: await this.manager.prepare(request),
        });
      case "plugins.origins":
        return PluginResponse.parse({ type: "plugins.origins", origins: this.manager.origins() });
      case "plugins.marketplace":
        return PluginResponse.parse({
          type: "plugins.marketplace",
          ...(await this.manager.marketplace(request)),
        });
      case "plugins.update":
        return PluginResponse.parse({
          type: "plugins.review",
          review: await this.manager.update(request.name),
        });
      case "plugins.accept":
        return PluginResponse.parse({
          type: "plugins.installed",
          install: await this.manager.accept(request),
        });
      case "plugins.remove":
        await this.manager.remove(request.name);
        return PluginResponse.parse({ type: "plugins.removed", name: request.name });
      case "plugins.cancel":
        await this.manager.cancel(request.id);
        return PluginResponse.parse({ type: "plugins.cancelled", id: request.id });
      case "plugins.readReview":
        return PluginResponse.parse(this.manager.readReview(request.id, request.offset));
      case "plugins.list":
        return PluginResponse.parse({
          type: "plugins.list",
          installs: this.manager.list(),
          reviews: this.manager.pendingSummaries(),
          ...(this.manager.list().length
            ? {
                availability: this.manager
                  .list()
                  .map((entry) => this.manager.availability(entry.name)),
              }
            : {}),
        });
    }
  }
}
