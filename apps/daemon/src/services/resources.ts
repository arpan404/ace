/** Resources register as soon as they open; every disposer runs even after failure. */
export class Resources {
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private readonly admissionStops: (() => void)[] = [];
  private readonly errors: unknown[] = [];
  onShutdown(stopAdmission: () => void): void {
    this.admissionStops.push(stopAdmission);
  }
  beginShutdown(): void {
    for (const stop of this.admissionStops.splice(0)) {
      try {
        stop();
      } catch (error) {
        this.errors.push(error);
      }
    }
  }
  own(dispose: () => void | Promise<void>): void {
    this.disposers.push(dispose);
  }
  async close(): Promise<void> {
    this.beginShutdown();
    const errors = this.errors.splice(0);
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
