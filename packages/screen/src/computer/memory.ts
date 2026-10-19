/*
 * What the toolkit remembers per caller: the last outline seen of each app (the diff
 * baseline), whether the app's note was shown, and which app a name resolved to. Bounded, so
 * a long-lived daemon never grows without limit. Pure: no I/O.
 */
import type { OutlineBaseline } from "./outline.ts";

const maxEntries = 256;

/** A Map that forgets its least recently set entry beyond `maxEntries`. */
class Recent<V> {
  private readonly entries = new Map<string, V>();
  get(key: string): V | undefined {
    return this.entries.get(key);
  }
  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }
  delete(key: string): void {
    this.entries.delete(key);
  }
}

export interface ResolvedApp {
  bundleId: string;
  name: string;
}

export class ComputerMemory {
  private readonly baselines = new Recent<OutlineBaseline>();
  private readonly noted = new Recent<true>();
  private readonly apps = new Recent<ResolvedApp>();

  baseline(key: string): OutlineBaseline | undefined {
    return this.baselines.get(key);
  }
  remember(key: string, baseline: OutlineBaseline): void {
    this.baselines.set(key, baseline);
  }
  /** True the first time it is asked for `key`. */
  firstNote(key: string): boolean {
    if (this.noted.get(key)) return false;
    this.noted.set(key, true);
    return true;
  }
  /** The app a caller's name for it resolved to earlier. */
  app(key: string): ResolvedApp | undefined {
    return this.apps.get(key);
  }
  resolved(key: string, app: ResolvedApp): void {
    this.apps.set(key, app);
  }
  forgetApp(key: string): void {
    this.apps.delete(key);
  }
}
