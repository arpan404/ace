import type { ServiceContext } from "./types.ts";
import type { ServiceStatus } from "./startup.ts";

/** Opening a service is bounded startup; processing saved user data is cancellable warmup. */
export function warmup(
  context: ServiceContext,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  let status: ServiceStatus = { name, state: "starting" };
  context.readiness?.(() => status);
  return Promise.resolve()
    .then(() => {
      context.signal.throwIfAborted();
      return run();
    })
    .then(
      () => {
        status = { name, state: "ready" };
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : "Background initialization failed";
        status = { name, state: "degraded", error: `Service ${name}: ${message.slice(0, 8192)}` };
        context.log.log("error", `Service ${name} warmup failed`, error);
      },
    );
}
