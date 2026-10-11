/** Serialize Chromium emulation changes and remember only the current placement. */
export class PageMetrics {
  private key = "";
  private applied = "";
  private pending: Promise<unknown> = Promise.resolve();

  matches(key: string): boolean {
    return this.key === key && this.applied === key;
  }

  place(key: string, apply: () => Promise<unknown>): Promise<unknown> {
    if (this.key === key) return this.pending;
    this.key = key;
    const result = this.enqueue(async () => {
      const value = await apply();
      this.applied = key;
      return value;
    });
    void result.catch(() => {
      if (this.key === key) this.key = "";
    });
    return result;
  }

  override(apply: () => Promise<unknown>): Promise<unknown> {
    this.key = "";
    this.applied = "";
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
