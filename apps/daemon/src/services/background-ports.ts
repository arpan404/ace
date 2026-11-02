import { logError } from "@ace/diagnostics";
import { systemPortProbe } from "../background-services/probe.ts";
import { BackgroundPortWatcher } from "../background-services/watcher.ts";
import { requireService } from "./composition.ts";
import type { ServiceContext } from "./types.ts";

/** Reports the ports background commands left running listen on (ADR 0109). */
export function startBackgroundPorts({ services, store, resources, log }: ServiceContext): void {
  const engine = requireService(services.engine, "engine");
  const watcher = new BackgroundPortWatcher({
    host: engine.backgroundPorts(),
    probe: systemPortProbe(),
    subscribe: (listener) => store.subscribe(listener),
    setTimer(callback, delay) {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    },
    onError: (error) => log.log("debug", "Background port probe failed", logError(error)),
  });
  resources.own(() => watcher.close());
}
