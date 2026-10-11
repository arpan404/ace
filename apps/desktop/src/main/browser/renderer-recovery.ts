/** One renderer recovery deadline; cancelled callbacks cannot detach a recovered page. */
export class RendererRecovery {
  private pending: (() => void) | undefined;
  private generation = 0;
  private readonly after: (ms: number, run: () => void) => () => void;
  private readonly failed: () => void;
  constructor(after: (ms: number, run: () => void) => () => void, failed: () => void) {
    this.after = after;
    this.failed = failed;
  }
  get active(): boolean {
    return this.pending !== undefined;
  }
  start(): void {
    this.ready();
    const generation = this.generation;
    this.pending = this.after(30_000, () => {
      if (generation !== this.generation) return;
      this.pending = undefined;
      this.generation++;
      this.failed();
    });
  }
  ready(): void {
    this.generation++;
    this.pending?.();
    this.pending = undefined;
  }
}
