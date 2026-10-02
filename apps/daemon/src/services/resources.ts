/** Resources register as soon as they open; every disposer runs even after failure. */
export class Resources {
  private readonly disposers: (() => void | Promise<void>)[] = [];
  own(dispose: () => void | Promise<void>): void {
    this.disposers.push(dispose);
  }
  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const dispose of this.disposers.splice(0).toReversed()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Daemon resource cleanup failed");
  }
}
