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
      case "plugins.prepare":
        return PluginResponse.parse({
          type: "plugins.review",
          review: await this.manager.prepare(request),
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
        });
    }
  }
}
