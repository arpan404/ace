import type { AutomationService } from "@ace/automations";
import { logError } from "@ace/diagnostics";
import type { ServiceContext } from "./services/types.ts";

/** Both host and agent-owned schedulers follow the same global admission lifecycle. */
export async function followAutomationSetting(
  context: ServiceContext,
  service: AutomationService,
): Promise<void> {
  const settings = context.services.settings;
  if (!settings) throw new Error("settings_unavailable");
  let stopped = false;
  let enabled = false;
  /** Who is waiting on model readiness: a later enable or disable turns the earlier one stale. */
  let arming = 0;
  context.resources.onShutdown(() => {
    stopped = true;
    arming++;
    service.stop();
  });
  /**
   * A schedule missed while ace was off catches up as soon as the scheduler starts, and its run
   * creates a thread with the automation's model. Model lists finish loading after the services
   * start (services/models.ts admits them behind `modelsReady`), so the scheduler waits for them
   * the way delegations do; otherwise the catch-up is spent on `model_unavailable` and lost.
   *
   * The wait is bounded: model discovery retries on its own in the background
   * (`@ace/models` catalog), and a first pass that never settles must not leave file and manual
   * automations off forever. Thirty seconds covers a cold provider's first list, which is
   * normally seconds, and is half the scheduler's own 60 s recheck, so a held run still lands
   * near its time. Once armed, a due run whose model is still loading stays due
   * (`packages/automations/src/service.ts`) and fires when `services.modelsReady` settles.
   */
  const startWhenReady = async () => {
    const turn = ++arming;
    const ready = context.services.modelsReady;
    if (ready) {
      const waitMs = context.options.automationModelWaitMs ?? 30_000;
      const deadline = context.now() + waitMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolve) => {
        const check = () => {
          const left = deadline - context.now();
          if (left > 0) {
            timer = setTimeout(check, left);
            timer.unref();
            return;
          }
          resolve();
        };
        timer = setTimeout(check, Math.max(0, deadline - context.now()));
        timer.unref();
      });
      try {
        await Promise.race([
          ready.catch((error: unknown) =>
            context.log.log("warn", "Model admission failed", logError(error)),
          ),
          bounded.then(() =>
            context.log.log(
              "warn",
              "Arming automations while model lists load; due runs stay due until they settle",
              { waitMs },
            ),
          ),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (turn !== arming || !enabled || stopped || context.signal.aborted) return;
    service.start();
    context.services.commands?.invalidateExtras?.();
  };
  const apply = async (value: unknown) => {
    enabled = value === true;
    if (stopped || context.signal.aborted) return;
    if (!enabled) {
      arming++;
      service.stop();
      context.services.commands?.invalidateExtras?.();
      return;
    }
    await startWhenReady();
  };
  const release = await settings.subscribe(
    { keys: ["automations.enabled"], scope: {} },
    (notification) => {
      if (notification.type === "changed")
        void apply(
          notification.entries.find((entry) => entry.key === "automations.enabled")?.value,
        );
    },
  );
  context.resources.own(release);
  // Not awaited: model admission runs behind startup, so the daemon never waits for it here.
  void apply((await settings.get("automations.enabled")).value);
}
