import type { ThreadId } from "@ace/protocol";

export interface ThreadApps {
  threadId: ThreadId;
  apps: readonly string[];
}

export interface ComputerUsingOptions {
  /** Schedules the linger after a thread's last call to an app ends. */
  after: (ms: number, run: () => void) => () => void;
  /** How long an app stays listed after its last call, so a working agent doesn't flicker. */
  lingerMs?: number;
}

interface Use {
  calls: number;
  stopLinger: (() => void) | undefined;
}

/**
 * The threads whose agent is using desktop apps now (computer use), from the calls in flight: an
 * app joins when a look or action starts and leaves a short while after the last one ends.
 * Listeners hear the whole set, and only when it changes.
 */
export class ComputerUsingThreads {
  private readonly options: ComputerUsingOptions;
  private readonly uses = new Map<ThreadId, Map<string, Use>>();
  private readonly listeners = new Set<(threads: readonly ThreadApps[]) => void>();
  private current: readonly ThreadApps[] = [];

  constructor(options: ComputerUsingOptions) {
    this.options = options;
  }

  /** A call by `threadId`'s agent in `app` started; the returned function ends it. */
  begin(threadId: ThreadId, app: string): () => void {
    const apps = this.uses.get(threadId) ?? new Map<string, Use>();
    this.uses.set(threadId, apps);
    const existing = apps.get(app);
    const use = existing ?? { calls: 0, stopLinger: undefined };
    use.calls++;
    use.stopLinger?.();
    use.stopLinger = undefined;
    if (!existing) {
      apps.set(app, use);
      this.changed();
    }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--use.calls > 0) return;
      use.stopLinger = this.options.after(this.options.lingerMs ?? 8_000, () => {
        if (use.calls > 0 || apps.get(app) !== use) return;
        apps.delete(app);
        if (!apps.size) this.uses.delete(threadId);
        this.changed();
      });
    };
  }

  threads(): readonly ThreadApps[] {
    return this.current;
  }

  subscribe(listener: (threads: readonly ThreadApps[]) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed(): void {
    this.current = [...this.uses].map(([threadId, apps]) => ({ threadId, apps: [...apps.keys()] }));
    for (const listener of this.listeners) listener(this.current);
  }
}
