import type { SettingsBackend } from "./backend.ts";
import { memoryValues } from "./values-store.ts";

async function unavailable(): Promise<never> {
  throw new Error("This daemon doesn't serve settings to the web app yet.");
}

/**
 * What a real daemon gets until @ace/client exposes settings, models and access requests.
 * Edits apply for this session only; lists report that the daemon can't answer yet, so the
 * pages show an honest error instead of fixture data.
 *
 * TODO(train-2): wire to protocol when merged. Replace with a `daemonBackend(client)`.
 */
export function pendingSettingsBackend(): SettingsBackend {
  const values = memoryValues({});
  return {
    values,
    set: async (key, value) => values.set(key, value),
    reset: async () => values.replace({}),
    providers: unavailable,
    rediscover: unavailable,
    addAcpAgent: unavailable,
    models: unavailable,
    refreshModels: unavailable,
    machines: unavailable,
    devices: unavailable,
    pair: unavailable,
    revoke: unavailable,
  };
}
