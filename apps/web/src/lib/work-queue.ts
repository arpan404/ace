/** Bounded shared jobs. A lease keeps a queued job alive until its last consumer leaves. */
const ignore = () => undefined;

export class WorkQueue<I, O> {
  private readonly jobs = new Map<string, Job<I, O>>();
  private readonly retained = new Set<Job<I, O>>();
  private active = false;
  private bytes = 0;
  private readonly work: (input: I, signal: AbortSignal) => Promise<O>;
  private readonly limit: { jobs: number; bytes: number };
  constructor(
    work: (input: I, signal: AbortSignal) => Promise<O>,
    limit: { jobs: number; bytes: number },
  ) {
    this.work = work;
    this.limit = limit;
  }

  acquire(key: string, input: I, bytes: number): Lease<O> {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      return { result: Promise.resolve(undefined), release() {} };
    let job = this.jobs.get(key);
    if (job?.controller.signal.aborted) job = undefined;
    if (!job) {
      if (
        bytes > this.limit.bytes ||
        this.bytes + bytes > this.limit.bytes ||
        this.retained.size >= this.limit.jobs
      )
        return { result: Promise.resolve(undefined), release() {} };
      let settle: (value: O | undefined) => void = ignore;
      const result = new Promise<O | undefined>((resolve) => {
        settle = resolve;
      });
      job = {
        key,
        input,
        bytes,
        consumers: 0,
        running: false,
        result,
        settle,
        controller: new AbortController(),
      };
      this.jobs.set(key, job);
      this.retained.add(job);
      this.bytes += bytes;
    }
    const owned = job;
    owned.consumers++;
    this.pump();
    let released = false;
    return {
      result: owned.result,
      release: () => {
        if (released) return;
        released = true;
        owned.consumers--;
        if (!owned.consumers) {
          owned.controller.abort();
          if (!owned.running) this.finish(owned, undefined);
        }
      },
    };
  }

  private finish(job: Job<I, O>, output: O | undefined) {
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    this.retained.delete(job);
    this.bytes -= job.bytes;
    job.settle(output);
  }

  private pump() {
    if (this.active) return;
    const job = [...this.retained].find((entry) => !entry.running);
    if (!job) return;
    this.active = true;
    job.running = true;
    void Promise.resolve()
      .then(() => (job.consumers ? this.work(job.input, job.controller.signal) : undefined))
      .then(
        (output) => this.finish(job, job.consumers ? output : undefined),
        () => this.finish(job, undefined),
      )
      .finally(() => {
        this.active = false;
        this.pump();
      });
  }
}

export interface Lease<O> {
  result: Promise<O | undefined>;
  release(): void;
}
interface Job<I, O> {
  controller: AbortController;
  key: string;
  input: I;
  bytes: number;
  consumers: number;
  running: boolean;
  result: Promise<O | undefined>;
  settle(value: O | undefined): void;
}
