import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { durableJson } from "@ace/service";
import { DesktopSettings } from "../shared/contract.ts";

/** Desktop-only preferences in Electron's userData. Invalid files fall back to defaults. */
export class SettingsStore {
  private value: DesktopSettings;
  private path: string;
  private listeners = new Set<(settings: DesktopSettings) => void>();
  /** Saves run one at a time; a failed one never blocks the next. */
  private writing: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
    this.value = load(path);
  }
  get(): DesktopSettings {
    return this.value;
  }
  onChange(listener: (settings: DesktopSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /**
   * Applies the patch on top of the last saved settings and saves durably. The new value is
   * kept (and listeners hear of it) only once it is on disk; a failed save changes nothing.
   */
  async update(patch: {
    [K in keyof DesktopSettings]?: DesktopSettings[K] | undefined;
  }): Promise<DesktopSettings> {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const saved = this.writing.then(async () => {
      const next = DesktopSettings.parse({ ...this.value, ...defined });
      await mkdir(dirname(this.path), { recursive: true });
      await durableJson(this.path, next);
      this.value = next;
      return next;
    });
    this.writing = saved.catch(() => {});
    const next = await saved;
    for (const listener of this.listeners) listener(next);
    return next;
  }
}

function load(path: string): DesktopSettings {
  try {
    const parsed = DesktopSettings.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.success) return parsed.data;
  } catch {
    // Missing or unreadable: defaults.
  }
  return DesktopSettings.parse({});
}
