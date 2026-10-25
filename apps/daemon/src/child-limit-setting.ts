import { SettingsValues } from "@ace/protocol";
import type { SettingsService } from "@ace/settings";

const key = "agents.maxRunningChildren";
const Limit = SettingsValues.shape[key];

/**
 * The person's limit on delegated children one parent runs at once, held for synchronous reads
 * at each launch. Undefined is no limit. Listeners hear each change so waiting children can
 * start as soon as the limit is raised or cleared.
 */
export class ChildLimitSetting {
  private limit: number | undefined;
  private listeners = new Set<() => void>();
  current(): number | undefined {
    return this.limit;
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  async start(settings: Pick<SettingsService, "subscribe" | "get">): Promise<() => void> {
    const apply = (value: unknown) => {
      const parsed = Limit.safeParse(value);
      // An unreadable value keeps the last good limit, as settings keep the last good file.
      if (!parsed.success) return;
      const next = parsed.data ?? undefined;
      if (next === this.limit) return;
      this.limit = next;
      for (const listener of this.listeners) listener();
    };
    const stop = await settings.subscribe({ keys: [key], scope: {} }, (notification) => {
      if (notification.type === "changed")
        apply(notification.entries.find((entry) => entry.key === key)?.value);
    });
    apply((await settings.get(key)).value);
    return stop;
  }
}
