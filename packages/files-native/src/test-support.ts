import type { FilesChild, FilesClock, FilesHost } from "./host.ts";

/** A clock whose timers run only when the test advances it. */
export class ManualClock implements FilesClock {
  #now = 0;
  #timers: { at: number; seq: number; run: () => void }[] = [];
  #seq = 0;

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): () => void {
    const timer = { at: this.#now + ms, seq: this.#seq++, run: callback };
    this.#timers.push(timer);
    return () => {
      this.#timers = this.#timers.filter((candidate) => candidate !== timer);
    };
  }

  /** Runs every timer due within `ms`, in order, letting promises settle between them. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      await settle();
      const next = this.#timers
        .filter((timer) => timer.at <= end)
        .toSorted((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!next) break;
      this.#timers = this.#timers.filter((timer) => timer !== next);
      this.#now = next.at;
      next.run();
    }
    this.#now = end;
    await settle();
  }
}

/** Let queued promise callbacks run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Wait for a condition that a real child process makes true, with a generous deadline. */
export async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting for the fake ace-files");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A host that remembers every child it spawned, so a test can kill one. */
export type TrackingHost = FilesHost & { readonly children: FilesChild[] };

export function trackingHost(inner: FilesHost): TrackingHost {
  const children: FilesChild[] = [];
  return {
    children,
    spawn(binary) {
      const child = inner.spawn(binary);
      children.push(child);
      return child;
    },
  };
}
