import {
  APPEARANCE_STORAGE_KEY,
  RETURN_SENDS_STORAGE_KEY,
  parseAppearanceMode,
  type AppearanceMode,
} from "./appearance.ts";
import {
  APP_LOCK_ENABLED_KEY,
  APP_LOCK_TIMEOUT_KEY,
  initialLockEnabled,
  resolveStoredLockTimeout,
} from "./appLock.ts";

/** Minimal async string store. SQLite, SecureStore, or memory all fit behind it. */
export interface SettingsKeyValue {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  /** Optional delete for rollback; backends without it leave torn keys behind (see below). */
  removeItem?(key: string): Promise<void>;
  /**
   * Optional crash-atomic multi-key commit (e.g. a SQLite transaction). When
   * present, the serialized writer uses it instead of best-effort rollback.
   */
  saveAtomic?(patch: Partial<SettingsState>): Promise<void>;
}

export interface SettingsState {
  readonly appearance: AppearanceMode;
  readonly returnSends: boolean;
  readonly lockEnabled: boolean;
  readonly lockTimeoutSeconds: number;
}

export const DEFAULT_SETTINGS: SettingsState = {
  appearance: "system",
  returnSends: false,
  lockEnabled: false,
  lockTimeoutSeconds: 60,
};

export const DEFAULT_LOCK_TIMEOUT_SECONDS = 60;

/** iOS `AppLockView.label(_:)`: 0 locks as soon as ace leaves the screen. */
export function lockTimeoutLabel(seconds: number): string {
  switch (seconds) {
    case 0:
      return "Immediately";
    case 60:
      return "1 minute";
    case 300:
      return "5 minutes";
    case 900:
      return "15 minutes";
    case 3600:
      return "1 hour";
    default:
      return `${seconds} seconds`;
  }
}

function parseStoredBoolean(value: string | null | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseStoredTimeout(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Merge raw stored strings into a full state. Every field falls back through
 * the existing module parsers, so corrupt or missing values can never enable
 * the Return key behavior, shorten the lock window, or pick an unknown mode.
 */
export function parseSettingsRecord(
  record: Record<string, string | null | undefined>,
  defaultLockEnabled = false,
): SettingsState {
  const storedTimeout = parseStoredTimeout(record[APP_LOCK_TIMEOUT_KEY]);
  return {
    appearance: parseAppearanceMode(record[APPEARANCE_STORAGE_KEY] ?? undefined),
    returnSends: parseStoredBoolean(record[RETURN_SENDS_STORAGE_KEY]) === true,
    lockEnabled: initialLockEnabled(
      parseStoredBoolean(record[APP_LOCK_ENABLED_KEY]),
      defaultLockEnabled,
    ),
    lockTimeoutSeconds: resolveStoredLockTimeout(storedTimeout, DEFAULT_LOCK_TIMEOUT_SECONDS),
  };
}

const SETTINGS_KEYS = [
  APPEARANCE_STORAGE_KEY,
  RETURN_SENDS_STORAGE_KEY,
  APP_LOCK_ENABLED_KEY,
  APP_LOCK_TIMEOUT_KEY,
] as const;

export async function loadSettings(
  storage: SettingsKeyValue,
  defaultLockEnabled = false,
): Promise<SettingsState> {
  const values = await Promise.all(SETTINGS_KEYS.map((key) => storage.getItem(key)));
  const record: Record<string, string | null | undefined> = {};
  SETTINGS_KEYS.forEach((key, index) => {
    record[key] = values[index];
  });
  return parseSettingsRecord(record, defaultLockEnabled);
}

export function encodeSettings(patch: Partial<SettingsState>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (patch.appearance !== undefined) entries.push([APPEARANCE_STORAGE_KEY, patch.appearance]);
  if (patch.returnSends !== undefined)
    entries.push([RETURN_SENDS_STORAGE_KEY, patch.returnSends ? "true" : "false"]);
  if (patch.lockEnabled !== undefined)
    entries.push([APP_LOCK_ENABLED_KEY, patch.lockEnabled ? "true" : "false"]);
  if (patch.lockTimeoutSeconds !== undefined)
    entries.push([APP_LOCK_TIMEOUT_KEY, String(patch.lockTimeoutSeconds)]);
  return entries;
}

/** Persist only the patched fields; every write is a plain string under a known key. */
export async function saveSettings(
  storage: SettingsKeyValue,
  patch: Partial<SettingsState>,
): Promise<void> {
  for (const [key, value] of encodeSettings(patch)) {
    await storage.setItem(key, value);
  }
}

/**
 * Best-effort variant of {@link saveSettings}. A multi-key patch that dies
 * halfway (e.g. the lock choice persisted but its timeout did not) would
 * otherwise leave storage torn: the in-memory rollback claims one state while
 * a restart reads another. On failure every touched key is restored to its
 * pre-write value — keys that did not exist are removed when the backend
 * supports `removeItem` — and the original error rethrows.
 *
 * This is NOT crash-atomic: a process kill between the individual writes can
 * still leave storage torn, and the restore itself can fail. Generic
 * key/value backends cannot do better. Crash-atomicity needs a real
 * transaction — SQLite callers must expose `saveAtomic` (see
 * `saveSettingsTransaction` in `sqlite.ts`), which the serialized writer
 * prefers over this fallback.
 */
export async function saveSettingsBestEffort(
  storage: SettingsKeyValue,
  patch: Partial<SettingsState>,
): Promise<void> {
  const entries = encodeSettings(patch);
  if (entries.length === 0) return;
  const keys = entries.map(([key]) => key);
  const before = await Promise.all(keys.map((key) => storage.getItem(key)));
  try {
    for (const [key, value] of entries) {
      await storage.setItem(key, value);
    }
  } catch (error) {
    await Promise.all(
      keys.map(async (key, index) => {
        const previous = before[index];
        try {
          if (previous === null || previous === undefined) {
            await storage.removeItem?.(key);
          } else {
            await storage.setItem(key, previous);
          }
        } catch {
          // Restore is best-effort; the original failure still throws below.
        }
      }),
    );
    throw error;
  }
}

/**
 * Strip the lock fields from a patch. The memory fallback shown before the
 * phone database opens must never carry `lockEnabled`/`lockTimeoutSeconds`
 * into the real store: migrating them would let an unauthenticated fallback
 * edit overwrite the locked state. Only interface preferences migrate.
 */
export function nonLockPatch(patch: Partial<SettingsState>): Partial<SettingsState> {
  return {
    ...(patch.appearance !== undefined ? { appearance: patch.appearance } : null),
    ...(patch.returnSends !== undefined ? { returnSends: patch.returnSends } : null),
  };
}

/**
 * Durable-save rule: the UI and the lock state follow what was actually
 * written. Optimistic state commits only on success; a failed save keeps the
 * previous durable state (in particular, a failed lock-enable never flips
 * the toggle on, so a restart cannot come back unlocked).
 */
export function resolveSettingsAfterSave(args: {
  previous: SettingsState;
  next: SettingsState;
  saveSucceeded: boolean;
}): SettingsState {
  return args.saveSucceeded ? args.next : args.previous;
}

/**
 * Serialized writer: concurrent `save` calls run in call order, so rapid
 * toggles can neither lose a patch nor persist values out of order. A failed
 * save rejects its own caller but never breaks the chain behind it. Patches
 * commit through the backend's crash-atomic `saveAtomic` when it offers one
 * (the SQLite transaction); otherwise they fall back to best-effort
 * rollback (see {@link saveSettingsBestEffort}), which is not crash-atomic.
 */
export function createSettingsWriter(storage: SettingsKeyValue): {
  save(patch: Partial<SettingsState>): Promise<void>;
} {
  const queue = createSerialQueue();
  return {
    save(patch: Partial<SettingsState>): Promise<void> {
      // Branch inside the queue: the commit (including the backend's
      // snapshot reads) must not start before earlier saves finish.
      return queue.enqueue(() =>
        storage.saveAtomic !== undefined
          ? storage.saveAtomic(patch)
          : saveSettingsBestEffort(storage, patch),
      );
    },
  };
}

/**
 * Generic serialized queue: enqueued tasks run one at a time in call order,
 * and a rejected task never breaks the chain behind it. Settings commits
 * run their whole read-modify-write through one of these so overlapping
 * updates linearize: each patch is computed from the previous task's state,
 * and a failed save rolls back only its own patch instead of clobbering a
 * newer durable commit.
 */
export function createSerialQueue(): {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
} {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task);
      tail = run.catch(() => undefined).then(() => undefined);
      return run;
    },
  };
}

/** In-memory store for tests and as a fallback when the phone database is unavailable. */
export function createMemorySettingsKeyValue(
  seed: Record<string, string> = {},
): SettingsKeyValue & { snapshot(): Record<string, string> } {
  const items = new Map<string, string>(Object.entries(seed));
  return {
    getItem: (key) => Promise.resolve(items.get(key) ?? null),
    setItem: (key, value) => {
      items.set(key, value);
      return Promise.resolve();
    },
    removeItem: (key) => {
      items.delete(key);
      return Promise.resolve();
    },
    snapshot: () => Object.fromEntries(items),
  };
}
