import { z } from "zod";

/*
 * Preferences the desktop app owns and applies itself: the login item, and which OS
 * notifications this computer shows and when. Its main process stores them and acts on every
 * change, so Settings edits them through the preload bridge (`window.ace.settings`), never
 * through daemon settings nothing on this machine reads.
 */

const Minute = z
  .number()
  .int()
  .min(0)
  .max(24 * 60 - 1);
/** Minutes after local midnight; `start > end` wraps past midnight. */
export const DesktopQuietHours = z.object({ start: Minute, end: Minute });
export type DesktopQuietHours = z.infer<typeof DesktopQuietHours>;
/** The desktop's notification categories this app edits; others round-trip untouched. */
export type DesktopCategory = "needsYou" | "finished" | "failed" | "agentSays";
const Notifications = z.looseObject({
  enabled: z.boolean(),
  categories: z.record(z.string(), z.boolean()),
  quietHours: DesktopQuietHours.nullable(),
});
export const DesktopPreferences = z.looseObject({
  openAtLogin: z.boolean(),
  notifications: Notifications,
});
export type DesktopPreferences = z.infer<typeof DesktopPreferences>;
export interface DesktopPreferencesPatch {
  openAtLogin?: boolean;
  notifications?: DesktopPreferences["notifications"];
}

export interface DesktopPreferencesStore {
  /** Undefined until the desktop has answered. */
  get(): DesktopPreferences | undefined;
  update(patch: DesktopPreferencesPatch): Promise<void>;
  subscribe(listener: () => void): () => void;
}

interface Bridge {
  get(): Promise<unknown>;
  update(patch: DesktopPreferencesPatch): Promise<unknown>;
  onChange(listener: (value: unknown) => void): unknown;
}

function bridgeOf(scope: object): Bridge | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("settings" in ace)) return undefined;
  const settings: unknown = ace.settings;
  if (typeof settings !== "object" || settings === null) return undefined;
  if (!("get" in settings) || typeof settings.get !== "function") return undefined;
  if (!("update" in settings) || typeof settings.update !== "function") return undefined;
  if (!("onChange" in settings) || typeof settings.onChange !== "function") return undefined;
  // Each member was checked to be a function; results are parsed before use.
  return settings as Bridge;
}

/** Whether this window can edit the desktop's preferences. */
export function hasDesktopPreferences(scope: object = globalThis): boolean {
  return bridgeOf(scope) !== undefined;
}

const stores = new WeakMap<object, DesktopPreferencesStore>();

/**
 * The desktop's preferences, live: one store per bridge, read once and then kept current by the
 * desktop's change events. Undefined in a browser, where there is no desktop to configure.
 */
export function desktopPreferences(
  scope: object = globalThis,
): DesktopPreferencesStore | undefined {
  const bridge = bridgeOf(scope);
  if (!bridge) return undefined;
  const existing = stores.get(bridge);
  if (existing) return existing;
  let value: DesktopPreferences | undefined;
  const listeners = new Set<() => void>();
  const accept = (raw: unknown) => {
    const parsed = DesktopPreferences.safeParse(raw);
    if (!parsed.success) return;
    value = parsed.data;
    for (const listener of listeners) listener();
  };
  const store: DesktopPreferencesStore = {
    get: () => value,
    async update(patch) {
      accept(await bridge.update(patch));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  stores.set(bridge, store);
  bridge.onChange(accept);
  void bridge.get().then(accept, () => {
    /* The desktop didn't answer: its rows stay hidden. */
  });
  return store;
}
