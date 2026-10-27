import { describe, expect, it } from "vitest";
import { APPEARANCE_STORAGE_KEY, RETURN_SENDS_STORAGE_KEY } from "./appearance.ts";
import { APP_LOCK_ENABLED_KEY, APP_LOCK_TIMEOUT_KEY } from "./appLock.ts";
import {
  createMemorySettingsKeyValue,
  createSerialQueue,
  createSettingsWriter,
  DEFAULT_SETTINGS,
  loadSettings,
  lockTimeoutLabel,
  parseSettingsRecord,
  resolveSettingsAfterSave,
  saveSettings,
  saveSettingsBestEffort,
  type SettingsKeyValue,
  type SettingsState,
} from "./store.ts";

describe("settings persistence", () => {
  it("starts from safe defaults when nothing is stored", async () => {
    const storage = createMemorySettingsKeyValue();
    expect(await loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips every field through plain strings", async () => {
    const storage = createMemorySettingsKeyValue();
    await saveSettings(storage, {
      appearance: "dark",
      returnSends: true,
      lockEnabled: true,
      lockTimeoutSeconds: 300,
    });
    expect(await loadSettings(storage)).toEqual({
      appearance: "dark",
      returnSends: true,
      lockEnabled: true,
      lockTimeoutSeconds: 300,
    });
    expect(storage.snapshot()).toEqual({
      [APPEARANCE_STORAGE_KEY]: "dark",
      [RETURN_SENDS_STORAGE_KEY]: "true",
      [APP_LOCK_ENABLED_KEY]: "true",
      [APP_LOCK_TIMEOUT_KEY]: "300",
    });
  });

  it("saves only the patched fields", async () => {
    const storage = createMemorySettingsKeyValue();
    await saveSettings(storage, { appearance: "light" });
    expect(storage.snapshot()).toEqual({ [APPEARANCE_STORAGE_KEY]: "light" });
    expect(await loadSettings(storage)).toEqual({ ...DEFAULT_SETTINGS, appearance: "light" });
  });

  it("falls back per field when stored values are corrupt", () => {
    expect(
      parseSettingsRecord({
        [APPEARANCE_STORAGE_KEY]: "neon",
        [RETURN_SENDS_STORAGE_KEY]: "yes",
        [APP_LOCK_ENABLED_KEY]: "maybe",
        [APP_LOCK_TIMEOUT_KEY]: "42",
      }),
    ).toEqual(DEFAULT_SETTINGS);
  });

  it("never turns Send with Return on for a non-true value", () => {
    for (const value of ["1", "TRUE", " true", "false", ""]) {
      expect(
        parseSettingsRecord({ [RETURN_SENDS_STORAGE_KEY]: value }).returnSends,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it("empty or non-numeric timeouts keep the default instead of Immediately", () => {
    for (const value of ["", "   ", "soon", "NaN"]) {
      expect(
        parseSettingsRecord({ [APP_LOCK_TIMEOUT_KEY]: value }).lockTimeoutSeconds,
        JSON.stringify(value),
      ).toBe(60);
    }
  });

  it("keeps an explicit lock choice over the paired default", async () => {
    const storage = createMemorySettingsKeyValue({ [APP_LOCK_ENABLED_KEY]: "false" });
    expect((await loadSettings(storage, true)).lockEnabled).toBe(false);
    const fresh = createMemorySettingsKeyValue();
    expect((await loadSettings(fresh, true)).lockEnabled).toBe(true);
  });

  it("labels timeouts like iOS Settings", () => {
    expect([
      lockTimeoutLabel(0),
      lockTimeoutLabel(60),
      lockTimeoutLabel(300),
      lockTimeoutLabel(900),
      lockTimeoutLabel(3600),
    ]).toEqual(["Immediately", "1 minute", "5 minutes", "15 minutes", "1 hour"]);
  });
});

describe("serialized settings writer", () => {
  it("applies concurrent saves in call order without losing patches", async () => {
    const calls: Array<string> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createMemorySettingsKeyValue();
    const deferred: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        calls.push(`start:${key}`);
        await gate;
        await inner.setItem(key, value);
        calls.push(`end:${key}`);
      },
    };
    const writer = createSettingsWriter(deferred);
    const first = writer.save({ appearance: "dark" });
    const second = writer.save({ returnSends: true });
    release();
    await Promise.all([first, second]);
    expect(await loadSettings(inner)).toEqual({
      ...DEFAULT_SETTINGS,
      appearance: "dark",
      returnSends: true,
    });
    expect(calls).toEqual([
      `start:${APPEARANCE_STORAGE_KEY}`,
      `end:${APPEARANCE_STORAGE_KEY}`,
      `start:${RETURN_SENDS_STORAGE_KEY}`,
      `end:${RETURN_SENDS_STORAGE_KEY}`,
    ]);
  });

  it("keeps the chain alive after a failed save", async () => {
    let fail = true;
    const inner = createMemorySettingsKeyValue();
    const flaky: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: (key, value) =>
        fail ? Promise.reject(new Error("unavailable")) : inner.setItem(key, value),
    };
    const writer = createSettingsWriter(flaky);
    await expect(writer.save({ appearance: "dark" })).rejects.toThrow("unavailable");
    fail = false;
    await writer.save({ appearance: "light" });
    expect(await loadSettings(inner)).toEqual({ ...DEFAULT_SETTINGS, appearance: "light" });
  });
});

describe("best-effort settings saves", () => {
  it("restores every touched key when a multi-key patch fails halfway", async () => {
    const inner = createMemorySettingsKeyValue({
      [APP_LOCK_ENABLED_KEY]: "false",
      [APP_LOCK_TIMEOUT_KEY]: "60",
    });
    let writes = 0;
    const torn: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        writes += 1;
        if (writes === 2) throw new Error("unavailable");
        await inner.setItem(key, value);
      },
      removeItem: (key) => inner.removeItem?.(key) ?? Promise.resolve(),
    };
    await expect(
      saveSettingsBestEffort(torn, { lockEnabled: true, lockTimeoutSeconds: 300 }),
    ).rejects.toThrow("unavailable");
    expect(await loadSettings(inner)).toEqual(DEFAULT_SETTINGS);
  });

  it("removes keys created by a torn write when the backend supports it", async () => {
    const inner = createMemorySettingsKeyValue();
    let writes = 0;
    const torn: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        writes += 1;
        if (writes === 2) throw new Error("unavailable");
        await inner.setItem(key, value);
      },
      removeItem: (key) => inner.removeItem?.(key) ?? Promise.resolve(),
    };
    await expect(
      saveSettingsBestEffort(torn, { appearance: "dark", returnSends: true }),
    ).rejects.toThrow("unavailable");
    expect(inner.snapshot()).toEqual({});
    expect(await loadSettings(inner)).toEqual(DEFAULT_SETTINGS);
  });

  it("still restores pre-existing keys when the backend cannot delete", async () => {
    const inner = createMemorySettingsKeyValue({ [APP_LOCK_ENABLED_KEY]: "false" });
    const noDelete: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        if (key === APP_LOCK_TIMEOUT_KEY) throw new Error("unavailable");
        await inner.setItem(key, value);
      },
    };
    await expect(
      saveSettingsBestEffort(noDelete, { lockEnabled: true, lockTimeoutSeconds: 300 }),
    ).rejects.toThrow("unavailable");
    expect(await inner.getItem(APP_LOCK_ENABLED_KEY)).toBe("false");
  });

  it("is a no-op for empty patches", async () => {
    let touched = false;
    const storage: SettingsKeyValue = {
      getItem: () => {
        touched = true;
        return Promise.resolve(null);
      },
      setItem: () => {
        touched = true;
        return Promise.resolve();
      },
    };
    await saveSettingsBestEffort(storage, {});
    expect(touched).toBe(false);
  });

  it("rethrows the original failure even when the restore fails too", async () => {
    const storage: SettingsKeyValue = {
      getItem: () => Promise.resolve("false"),
      setItem: () => Promise.reject(new Error("restore unavailable")),
    };
    await expect(saveSettingsBestEffort(storage, { lockEnabled: true })).rejects.toThrow(
      "restore unavailable",
    );
  });
});

describe("writer atomic backend", () => {
  it("prefers the backend's crash-atomic commit when offered", async () => {
    const inner = createMemorySettingsKeyValue();
    const seen: Array<Partial<SettingsState>> = [];
    let setItemCalls = 0;
    const storage: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: (key, value) => {
        setItemCalls += 1;
        return inner.setItem(key, value);
      },
      saveAtomic: async (patch) => {
        seen.push(patch);
      },
    };
    const writer = createSettingsWriter(storage);
    await writer.save({ lockEnabled: true, lockTimeoutSeconds: 300 });
    expect(seen).toEqual([{ lockEnabled: true, lockTimeoutSeconds: 300 }]);
    expect(setItemCalls).toBe(0);
    expect(await loadSettings(inner)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to best-effort rollback without an atomic backend", async () => {
    const inner = createMemorySettingsKeyValue({
      [APP_LOCK_ENABLED_KEY]: "false",
      [APP_LOCK_TIMEOUT_KEY]: "60",
    });
    let writes = 0;
    const torn: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        writes += 1;
        if (writes === 2) throw new Error("unavailable");
        await inner.setItem(key, value);
      },
      removeItem: (key) => inner.removeItem?.(key) ?? Promise.resolve(),
    };
    const writer = createSettingsWriter(torn);
    await expect(writer.save({ lockEnabled: true, lockTimeoutSeconds: 300 })).rejects.toThrow(
      "unavailable",
    );
    expect(await loadSettings(inner)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("serialized settings commits", () => {
  it("runs enqueued tasks in call order", async () => {
    const queue = createSerialQueue();
    const order: Array<string> = [];
    await Promise.all([
      queue.enqueue(async () => {
        order.push("first");
      }),
      queue.enqueue(async () => {
        order.push("second");
      }),
    ]);
    expect(order).toEqual(["first", "second"]);
  });

  it("keeps the chain alive after a rejected task", async () => {
    const queue = createSerialQueue();
    const order: Array<string> = [];
    await expect(
      queue.enqueue(async () => {
        order.push("failing");
        throw new Error("unavailable");
      }),
    ).rejects.toThrow("unavailable");
    await queue.enqueue(async () => {
      order.push("next");
    });
    expect(order).toEqual(["failing", "next"]);
  });

  it("commits overlapping patches in call order with no lost update", async () => {
    const storage = createMemorySettingsKeyValue();
    const writer = createSettingsWriter(storage);
    const queue = createSerialQueue();
    let current: SettingsState = { ...DEFAULT_SETTINGS };
    const seen: Array<SettingsState> = [];
    async function update(patch: Partial<SettingsState>): Promise<void> {
      return queue.enqueue(async () => {
        const previous = current;
        const next: SettingsState = { ...previous, ...patch };
        current = next;
        try {
          await writer.save(patch);
        } catch {
          current = resolveSettingsAfterSave({ previous, next, saveSucceeded: false });
          return;
        }
        seen.push(next);
      });
    }
    await Promise.all([update({ lockEnabled: true }), update({ lockTimeoutSeconds: 300 })]);
    const expected: SettingsState = {
      ...DEFAULT_SETTINGS,
      lockEnabled: true,
      lockTimeoutSeconds: 300,
    };
    expect(current).toEqual(expected);
    expect(await loadSettings(storage)).toEqual(expected);
    expect(seen).toEqual([{ ...DEFAULT_SETTINGS, lockEnabled: true }, expected]);
  });

  it("keeps rapid opposite toggles in order, last call wins durably", async () => {
    const storage = createMemorySettingsKeyValue();
    const writer = createSettingsWriter(storage);
    const queue = createSerialQueue();
    let current: SettingsState = { ...DEFAULT_SETTINGS };
    const seen: Array<SettingsState> = [];
    async function update(patch: Partial<SettingsState>): Promise<void> {
      return queue.enqueue(async () => {
        const next: SettingsState = { ...current, ...patch };
        current = next;
        await writer.save(patch);
        seen.push(next);
      });
    }
    await Promise.all([update({ lockEnabled: true }), update({ lockEnabled: false })]);
    expect(current).toEqual(DEFAULT_SETTINGS);
    expect(await loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
    expect(seen).toEqual([{ ...DEFAULT_SETTINGS, lockEnabled: true }, DEFAULT_SETTINGS]);
  });

  it("a failed first save never rolls back the second call's durable commit", async () => {
    const inner = createMemorySettingsKeyValue();
    let writes = 0;
    const flaky: SettingsKeyValue = {
      getItem: (key) => inner.getItem(key),
      setItem: async (key, value) => {
        writes += 1;
        if (writes === 1) throw new Error("unavailable");
        await inner.setItem(key, value);
      },
      removeItem: (key) => inner.removeItem?.(key) ?? Promise.resolve(),
    };
    const writer = createSettingsWriter(flaky);
    const queue = createSerialQueue();
    let current: SettingsState = { ...DEFAULT_SETTINGS };
    const seen: Array<SettingsState> = [];
    const notes: Array<string> = [];
    async function update(patch: Partial<SettingsState>): Promise<void> {
      // Mirrors `SettingsScreen.update`: the previous state is read inside
      // the queue, so a failed save rolls back only its own patch.
      return queue.enqueue(async () => {
        const previous = current;
        const next: SettingsState = { ...previous, ...patch };
        current = next;
        try {
          await writer.save(patch);
        } catch {
          notes.push("Settings could not be saved on this phone.");
          current = resolveSettingsAfterSave({ previous, next, saveSucceeded: false });
          return;
        }
        seen.push(next);
      });
    }
    await Promise.all([update({ lockEnabled: true }), update({ lockTimeoutSeconds: 300 })]);
    // The failed lock-enable rolls back only itself; the timeout commit
    // stands in both memory and storage, and only it propagates.
    const expected: SettingsState = { ...DEFAULT_SETTINGS, lockTimeoutSeconds: 300 };
    expect(current).toEqual(expected);
    expect(await loadSettings(inner)).toEqual(expected);
    expect(seen).toEqual([expected]);
    expect(notes).toEqual(["Settings could not be saved on this phone."]);
  });
});
