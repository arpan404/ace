type Dispose = () => void | Promise<void>;

/** How a disposer is named in a shutdown that overran its deadline. */
export interface ResourceLabel {
  name: string;
  /** Names of the parts still closing inside this resource, when it owns its own. */
  pending?: () => readonly string[];
}

interface Entry {
  label: ResourceLabel;
  dispose: Dispose;
}

/**
 * The registering source line (`dir/file.ts:line`), so an unnamed disposer still says where
 * it came from. Only the last two path segments are kept: no home directory reaches a log.
 */
function callSite(): string {
  const frames = new Error("resource").stack?.split("\n") ?? [];
  // Frames: message, callSite, own/ownParallel, caller.
  const frame = frames.find((line, index) => index > 2 && !line.includes("/resources.ts:"));
  const location = /\(?([^\s()]+):(\d+):\d+\)?\s*$/.exec(frame ?? "");
  if (!location?.[1]) return "unnamed resource";
  const path = location[1].replace(/^file:\/\//, "").split(/[\\/]/);
  return `${path.slice(-2).join("/")}:${location[2]}`;
}

function labelOf(label: string | ResourceLabel | undefined): ResourceLabel {
  if (typeof label === "string") return { name: label };
  return label ?? { name: callSite() };
}

/** Resources register as soon as they open; every disposer runs even after failure. */
export class Resources {
  private readonly disposers: Entry[] = [];
  private readonly parallel: Entry[] = [];
  private readonly admissionStops: (() => void)[] = [];
  private readonly running = new Set<Entry>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  private draining: Promise<void> | undefined;
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
  /** Disposers close in reverse order of registration. */
  own(dispose: Dispose, label?: string | ResourceLabel): void {
    const entry = { label: labelOf(label), dispose };
    if (this.closing) {
      // An aborted startup can finish acquiring a resource after cleanup began.
      void this.run(entry).catch((error: unknown) => this.errors.push(error));
    } else this.disposers.push(entry);
  }
  /** Independent service owners close together; shared dependencies still close last. */
  ownParallel(dispose: Dispose, label?: string | ResourceLabel): void {
    const entry = { label: labelOf(label), dispose };
    if (this.draining || this.closing) {
      void this.run(entry).catch((error: unknown) => this.errors.push(error));
    } else this.parallel.push(entry);
  }
  /**
   * Names of disposers that started and have not finished, then of those still waiting for
   * them, so a shutdown deadline can say what it waited on.
   */
  pending(): string[] {
    const names: string[] = [];
    for (const entry of this.running) {
      const inner = entry.label.pending?.() ?? [];
      names.push(inner.length ? `${entry.label.name} (${inner.join(", ")})` : entry.label.name);
    }
    return names;
  }
  closeIndependent(): Promise<void> {
    this.beginShutdown();
    this.draining ??= Promise.allSettled(
      this.parallel.splice(0).map((entry) => this.run(entry)),
    ).then((results) => {
      for (const result of results)
        if (result.status === "rejected") this.errors.push(result.reason);
    });
    return this.draining;
  }
  close(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.dispose());
    return this.closing;
  }
  private async run(entry: Entry): Promise<void> {
    this.running.add(entry);
    try {
      await entry.dispose();
    } finally {
      this.running.delete(entry);
    }
  }
  private async dispose(): Promise<void> {
    this.beginShutdown();
    await this.closeIndependent();
    const errors = this.errors.splice(0);
    for (const entry of this.disposers.splice(0).toReversed()) {
      try {
        await this.run(entry);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Daemon resource cleanup failed");
  }
}
