/** Resources register as soon as they open; every disposer runs even after failure. */
export class Resources {
  private readonly disposers: (() => void | Promise<void>)[] = [];
  private readonly admissionStops: (() => void)[] = [];
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly errors: unknown[] = [];
  onShutdown(stopAdmission: () => void): void {
    if (this.stopped) stopAdmission();
    else this.admissionStops.push(stopAdmission);
  }
  beginShutdown(): void {
    this.stopped = true;
    for (const stop of this.admissionStops.splice(0)) {
      try {
        stop();
      } catch (error) {
        this.errors.push(error);
      }
    }
  }
  own(dispose: () => void | Promise<void>): void {
    if (this.closing) {
      // An aborted startup can finish acquiring a resource after cleanup began.
      void Promise.resolve()
        .then(dispose)
        .catch((error: unknown) => this.errors.push(error));
    } else this.disposers.push(dispose);
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.dispose());
    return this.closing;
  }
  private async dispose(): Promise<void> {
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
