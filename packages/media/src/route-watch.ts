import {
  changedRoutes,
  mediaRoutes,
  type MediaRoutes,
  type RouteCapabilities,
  type SourceKind,
} from "./routes.ts";
import type { MediaHealth, MediaSettings } from "./supervision-policy.ts";

export type RouteWatchOptions = {
  settings: () => MediaSettings;
  health: () => MediaHealth;
  capabilities: () => RouteCapabilities;
  /** The routes changed for these kinds: reconfigure their producers and consumers. */
  onChange: (routes: MediaRoutes, changed: SourceKind[]) => void;
};

/**
 * Keeps the daemon's current route table. The daemon calls `update()` whenever an input may have
 * changed: a setting, the supervisor's `replay` (ace-media is up) and `onExit` (it went away). So
 * when ace-media dies, producers routed to it are pointed back at the daemon at once.
 */
export class RouteWatch {
  readonly #options: RouteWatchOptions;
  #routes: MediaRoutes;

  constructor(options: RouteWatchOptions) {
    this.#options = options;
    this.#routes = this.#compute();
  }

  routes(): MediaRoutes {
    return this.#routes;
  }

  update(): void {
    const next = this.#compute();
    const changed = changedRoutes(this.#routes, next);
    this.#routes = next;
    if (changed.length > 0) this.#options.onChange(next, changed);
  }

  #compute(): MediaRoutes {
    const { settings, health, capabilities } = this.#options;
    return mediaRoutes(settings(), health(), capabilities());
  }
}
