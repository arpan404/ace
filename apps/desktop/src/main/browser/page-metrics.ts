/** Serialize Chromium emulation changes and remember only the current placement. */
export class PageMetrics {
  private key = "";
  private pending: Promise<unknown> = Promise.resolve();

  place(key: string, apply: () => Promise<unknown>): Promise<unknown> {
    if (this.key === key) return this.pending;
    this.key = key;
    const result = this.enqueue(apply);
    void result.catch(() => {
      if (this.key === key) this.key = "";
    });
    return result;
  }

  override(apply: () => Promise<unknown>): Promise<unknown> {
    this.key = "";
    return this.enqueue(apply);
  }

  settled(): Promise<unknown> {
    return this.pending;
  }

  private enqueue(apply: () => Promise<unknown>): Promise<unknown> {
    this.pending = this.pending.catch(() => {}).then(apply);
    return this.pending;
  }
}
