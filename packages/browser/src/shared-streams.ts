/**
 * Live-view streams one connection has asked the daemon for, one per target however many views
 * show it. The daemon keeps one stream per target per connection, so a second subscribe is
 * wasted and the first view's unsubscribe would cut the others. `retain` opens a target's
 * stream for its first view and closes it after its last; `reset` (a new connection) forgets
 * them all, and releases held from before it do nothing.
 */
export class SharedStreams {
  private readonly views = new Map<string, number>();
  private generation = 0;
  retain(target: string, open: () => void, close: () => void): () => void {
    const count = this.views.get(target) ?? 0;
    this.views.set(target, count + 1);
    if (count === 0) open();
    const generation = this.generation;
    let held = true;
    return () => {
      if (!held || generation !== this.generation) return;
      held = false;
      const left = (this.views.get(target) ?? 1) - 1;
      if (left > 0) return void this.views.set(target, left);
      this.views.delete(target);
      close();
    };
  }
  /** A replacement native capture needs a subscription even if its view stayed mounted. */
  refresh(target: string, open: () => void): void {
    if (this.views.has(target)) open();
  }
  reset(): void {
    this.generation++;
    this.views.clear();
  }
}
