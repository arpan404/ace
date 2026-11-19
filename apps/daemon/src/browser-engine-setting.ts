import type { EnginePreferencePort } from "@ace/browser";
import { BrowserBackendPreference, ThreadId } from "@ace/protocol";
import type { SettingsError, SettingsService } from "@ace/settings";
import { settingsScope } from "./settings.ts";
import type { Store } from "./store.ts";

/**
 * A thread's `browser.backend` as an engine move (ADR 0193) reads and keeps it: the value the
 * thread resolves to, and a write on the thread's own layer. `refusal` says why this caller may
 * not write the setting (an agent's device, ADR 0190), asked before every write.
 */
export function engineSetting(
  settings: SettingsService,
  store: Store,
  refusal: () => Promise<SettingsError | undefined>,
): EnginePreferencePort {
  return {
    async read(threadId) {
      const id = ThreadId.parse(threadId);
      const entry = await settings.get("browser.backend", settingsScope(store, { threadId: id }));
      const parsed = BrowserBackendPreference.safeParse(entry.value);
      return parsed.success ? parsed.data : undefined;
    },
    async write(threadId, value) {
      const refused = await refusal();
      if (refused) throw refused;
      await settings.set("browser.backend", value, {
        kind: "thread",
        thread: ThreadId.parse(threadId),
      });
    },
  };
}
