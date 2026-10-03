import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DesktopSettings } from "../shared/contract.ts";

/** Desktop-only preferences in Electron's userData. Invalid files fall back to defaults. */
export class SettingsStore {
  private value: DesktopSettings;
  private path: string;
  private listeners = new Set<(settings: DesktopSettings) => void>();
  private writing: Promise<void> = Promise.resolve();

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
  async update(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
    this.value = DesktopSettings.parse({ ...this.value, ...patch });
    const snapshot = JSON.stringify(this.value, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(`${this.path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${this.path}.tmp`, this.path);
    });
    await this.writing;
    for (const listener of this.listeners) listener(this.value);
    return this.value;
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
