import { PluginRequest, PluginResponse } from "@ace/protocol/plugins";
import type { PluginManager } from "./manager.ts";

/** Standalone validated command boundary for the daemon command owner to mount. */
export class PluginService {
  private readonly manager: PluginManager;
  constructor(manager: PluginManager) {
    this.manager = manager;
  }
  async handle(input: unknown): Promise<PluginResponse> {
    const request = PluginRequest.parse(input);
    switch (request.type) {
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
