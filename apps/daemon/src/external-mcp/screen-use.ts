import type { OutsideScreenUse } from "@ace/protocol";

interface Use {
  name: string;
  /** Calls in flight per app. */
  apps: Map<string, { calls: number; stopLinger: (() => void) | undefined }>;
  stop: AbortController;
}

/**
 * Outside clients using this machine's screen now (ADR 0122), for "Claude is using this Mac"
 * with Stop. An app joins when a look or action starts and leaves a short while after its last
 * call ends; `stop` ends the client's screen work at once and clears its line. Listeners hear the
 * whole list, only when it changes.
 */
export class OutsideScreen {
  private uses = new Map<string, Use>();
  private listeners = new Set<(uses: readonly OutsideScreenUse[]) => void>();
  private after: (ms: number, run: () => void) => () => void;
  private lingerMs: number;
  constructor(after: (ms: number, run: () => void) => () => void, lingerMs = 8_000) {
    this.after = after;
    this.lingerMs = lingerMs;
  }
  /**
   * The signal a grant's screen calls run under; a Stop aborts it, and the next call gets a
   * fresh one.
   */
  signal(grantId: string, name: string): AbortSignal {
    return this.entry(grantId, name).stop.signal;
  }
  /** A screen call by `grantId` in `app` started; the returned function ends it. */
  begin(grantId: string, name: string, app: string): () => void {
    const use = this.entry(grantId, name);
    const existing = use.apps.get(app);
    const entry = existing ?? { calls: 0, stopLinger: undefined };
    entry.calls++;
    entry.stopLinger?.();
    entry.stopLinger = undefined;
    if (!existing) {
      use.apps.set(app, entry);
      this.changed();
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--entry.calls > 0) return;
      entry.stopLinger = this.after(this.lingerMs, () => {
        if (entry.calls > 0 || use.apps.get(app) !== entry || this.uses.get(grantId) !== use)
          return;
        use.apps.delete(app);
        this.changed();
      });
    };
  }
  /** Ends a grant's screen work now; false when it had none. */
  stop(grantId: string): boolean {
    const use = this.uses.get(grantId);
    if (!use) return false;
    this.uses.delete(grantId);
    for (const app of use.apps.values()) app.stopLinger?.();
    use.stop.abort();
    if (use.apps.size) this.changed();
    return true;
  }
  current(): OutsideScreenUse[] {
    return [...this.uses]
      .filter(([, use]) => use.apps.size > 0)
      .slice(0, 64)
      .map(([grantId, use]) => ({
        grantId,
        name: use.name,
        apps: [...use.apps.keys()].slice(0, 16),
      }));
  }
  subscribe(listener: (uses: readonly OutsideScreenUse[]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private entry(grantId: string, name: string): Use {
    let use = this.uses.get(grantId);
    if (!use) {
      use = { name, apps: new Map(), stop: new AbortController() };
      this.uses.set(grantId, use);
    }
    return use;
  }
  private changed(): void {
    const uses = this.current();
    for (const listener of this.listeners) listener(uses);
  }
}
