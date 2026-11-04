import type { ClientApi } from "@ace/client";
import { useClient } from "@ace/client-react";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { z } from "zod";
import { desktopPreferences, type DesktopPreferencesStore } from "@/boot/desktop-settings.ts";
import { useOptionalStorage } from "./layout.tsx";

/*
 * Where a device keeps its own shortcut rebindings. Each app and browser has its own: the
 * desktop app in its settings store (through the preload bridge), a browser in local storage.
 * The machine's `clients.keybindings` setting, which every client once shared, is read only
 * once, by a device that has never stored any, to adopt what it held.
 */

/** Keymap id → keys, only the rebound ones. Ids and keys are checked by the keymap on use. */
type Rebindings = Readonly<Record<string, string>>;

export interface DeviceKeymap {
  /** Undefined until it can be read (the desktop hasn't answered); null: never stored here. */
  get(): Rebindings | null | undefined;
  set(next: Rebindings): Promise<void>;
  subscribe(listener: () => void): () => void;
}

const keymapStorageKey = "ace.keybindings";
/** Keymap id → keys in keymap notation, as the machine's old setting held them. */
const StoredKeybindings = z.record(z.string().max(64), z.string().min(1).max(64));
const Stored = StoredKeybindings.nullable();

/** A browser's rebindings in local storage, shared by its tabs. */
export function browserKeymap(storage: KeyValueStorage | undefined): DeviceKeymap {
  const read = () => readJson(storage, keymapStorageKey, Stored, null);
  let value = read();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  // Another tab of this browser saved: same device, so the same shortcuts.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== keymapStorageKey) return;
    value = read();
    notify();
  };
  return {
    get: () => value,
    async set(next) {
      writeJson(storage, keymapStorageKey, next);
      value = next;
      notify();
    },
    subscribe(listener) {
      if (!listeners.size) globalThis.addEventListener?.("storage", onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) globalThis.removeEventListener?.("storage", onStorage);
      };
    },
  };
}

/** The desktop app's rebindings, in its own settings store; every window hears a change. */
export function desktopKeymap(store: DesktopPreferencesStore): DeviceKeymap {
  return {
    get: () => {
      const value = store.get();
      return value === undefined ? undefined : value.keybindings;
    },
    set: (next) => store.update({ keybindings: next }),
    subscribe: (listener) => store.subscribe(listener),
  };
}

const browserKeymaps = new WeakMap<object, DeviceKeymap>();
const unstored = {};

/** This device's keymap store: one per desktop bridge, or per browser storage. */
export function deviceKeymap(storage: KeyValueStorage | undefined): DeviceKeymap {
  const desktop = desktopPreferences();
  if (desktop) return desktopKeymap(desktop);
  const owner = storage ?? unstored;
  let keymap = browserKeymaps.get(owner);
  if (!keymap) {
    keymap = browserKeymap(storage);
    browserKeymaps.set(owner, keymap);
  }
  return keymap;
}

/** This device's keymap store, for the app's storage. */
export function useDeviceKeymap(): DeviceKeymap {
  const storage = useOptionalStorage();
  return useMemo(() => deviceKeymap(storage), [storage]);
}

/** What the machine's old shared setting held, or none when nobody set it. */
export async function legacyKeybindings(client: ClientApi): Promise<unknown> {
  const reply = await client.request({
    type: "settings.get",
    key: "clients.keybindings",
    scope: {},
  });
  if (!reply.ok) throw new Error("The machine didn't answer.");
  const entry = reply.entries.find((item) => item.key === "clients.keybindings");
  return entry && entry.provenance !== "defaults" ? entry.value : {};
}

/**
 * This device's rebindings, live. A device that has never stored any adopts the machine's old
 * shared setting once (`clean` keeps only what this build knows); after that the machine's
 * setting is never read again, and changes made elsewhere never reach this device.
 */
export function useDeviceKeybindings(
  clean: (raw: unknown) => Rebindings,
): Rebindings | null | undefined {
  const keymap = useDeviceKeymap();
  const client = useClient();
  const stored = useSyncExternalStore(keymap.subscribe, keymap.get, keymap.get);
  useEffect(() => {
    if (stored !== null) return;
    let current = true;
    legacyKeybindings(client).then(
      (legacy) => {
        // A rebinding saved meanwhile wins over the old setting.
        if (current && keymap.get() === null) void keymap.set(clean(legacy)).catch(() => {});
      },
      () => {
        /* Offline: tried again on the next start. Defaults apply until then. */
      },
    );
    return () => {
      current = false;
    };
  }, [stored, keymap, client, clean]);
  return stored;
}
