import { ProviderConfigurations, type ProviderKind } from "@ace/protocol";
import { providerConfiguration } from "@ace/models/preferences";
import type { SettingsService } from "@ace/settings";

/** Holds the validated global setting for synchronous admission and cached catalog reads. */
export class ProviderConfigurationsState {
  private value: ProviderConfigurations = [];
  private listeners = new Set<() => void>();
  current(): ProviderConfigurations {
    return this.value;
  }
  for(provider: ProviderKind, instance?: string) {
    return providerConfiguration(this.value, provider, instance);
  }
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async start(settings: SettingsService): Promise<() => void> {
    const update = (value: unknown) => {
      this.value = ProviderConfigurations.parse(value);
      for (const listener of this.listeners) listener();
    };
    const stop = await settings.subscribe(
      { keys: ["providers.configuration"], scope: {} },
      (notification) => {
        if (notification.type === "changed")
          for (const entry of notification.entries) update(entry.value);
      },
    );
    update((await settings.get("providers.configuration")).value);
    return stop;
  }
}
