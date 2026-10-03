import type { z } from "zod";

/** The subset of Web Storage the app uses; injected so tests and Electron can swap it. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

/** Storage is outside the process boundary, so every read is parsed and falls back on error. */
export function readJson<T>(
  storage: KeyValueStorage | undefined,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  try {
    const raw = storage?.getItem(key);
    if (raw == null) return fallback;
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function writeJson(storage: KeyValueStorage | undefined, key: string, value: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    /* Private mode or quota: the value stays in memory for this session. */
  }
}
