import type { ServiceContext, Services } from "./types.ts";

/**
 * Follows a service another one may start without: `listener` hears its value now and each time
 * startup publishes, replaces or withdraws it. A context built without startup (some tests) has
 * nothing to follow, so the listener hears the value once.
 */
export function followService<K extends keyof Services>(
  context: Pick<ServiceContext, "services" | "watchService">,
  key: K,
  listener: (value: Services[K] | undefined) => void,
): () => void {
  if (context.watchService) return context.watchService(key, listener);
  listener(context.services[key]);
  return () => {};
}
