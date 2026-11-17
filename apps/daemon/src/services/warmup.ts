import { logError } from "@ace/diagnostics";
import type { ServiceContext } from "./types.ts";
import type { ServiceStatus } from "./startup.ts";

/**
 * Opening a service is bounded startup; processing saved user data is cancellable warmup. A
 * failed warmup leaves the service running and says so until the daemon restarts: use
 * `repeatableWarmup` when `run` can safely run again.
 */
export function warmup(
  context: ServiceContext,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  return execute(context, name, run, false);
}

/**
 * A warmup whose `run` is safe to repeat (idempotent, and cleaning up after itself when it
 * fails). When it fails, startup runs it again on the service retry schedule, without closing or
 * restarting the service, and the status turns ready as soon as one run succeeds.
 */
export function repeatableWarmup(
  context: ServiceContext,
  name: string,
  run: () => Promise<void>,
): Promise<void> {
  return execute(context, name, run, true);
}

function execute(
  context: ServiceContext,
  name: string,
  run: () => Promise<void>,
  repeatable: boolean,
): Promise<void> {
  let status: ServiceStatus = { name, state: "starting" };
  /** A run again keeps the failure showing until it succeeds: no flicker through "starting". */
  const again = () => attempt();
  const report = () => context.readiness?.(() => status, repeatable ? again : undefined);
  const attempt = (): Promise<void> =>
    Promise.resolve()
      .then(() => {
        context.signal.throwIfAborted();
        return run();
      })
      .then(
        () => {
          status = { name, state: "ready" };
          report();
        },
        (error: unknown) => {
          if (
            context.signal.aborted &&
            (error === context.signal.reason ||
              (error instanceof Error && error.name === "AbortError"))
          )
            return;
          const message =
            error instanceof Error ? error.message : "Background initialization failed";
          status = { name, state: "degraded", error: `Service ${name}: ${message.slice(0, 8192)}` };
          report();
          context.log.log("error", `Service ${name} warmup failed`, logError(error));
        },
      );
  report();
  return attempt();
}
