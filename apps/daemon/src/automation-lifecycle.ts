import type { AutomationService } from "@ace/automations";
import type { ServiceContext } from "./services/types.ts";

/** Both host and agent-owned schedulers follow the same global admission lifecycle. */
export async function followAutomationSetting(
  context: ServiceContext,
  service: AutomationService,
): Promise<void> {
  const settings = context.services.settings;
  if (!settings) throw new Error("settings_unavailable");
  let stopped = false;
  context.resources.onShutdown(() => {
    stopped = true;
    service.stop();
  });
  const apply = (enabled: unknown) => {
    if (stopped || context.signal.aborted) return;
    if (enabled === true) service.start();
    if (enabled === false) service.stop();
    context.services.commands?.invalidateExtras?.();
  };
  const release = await settings.subscribe(
    { keys: ["automations.enabled"], scope: {} },
    (notification) => {
      if (notification.type === "changed")
        apply(notification.entries.find((entry) => entry.key === "automations.enabled")?.value);
    },
  );
  context.resources.own(release);
  apply((await settings.get("automations.enabled")).value);
}
