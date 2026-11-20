import type { EnginePreferencePort } from "@ace/browser";
import { ThreadId } from "@ace/protocol";
import type { SettingsError, SettingsService } from "@ace/settings";

/**
 * A thread's `browser.backend` as an engine move (ADR 0199) keeps it: a write on the thread's
 * own layer once the browser opened on the new engine. `refusal` says why this caller may not
 * write the setting (an agent's device, ADR 0190), asked before every write.
 */
export function engineSetting(
  settings: SettingsService,
  refusal: () => Promise<SettingsError | undefined>,
): EnginePreferencePort {
  return {
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
