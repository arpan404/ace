/** A read the background refresh gave up waiting for. The read itself may still finish later. */
export class RefreshTimeout extends Error {
  readonly step: string;
  constructor(step: string, ms: number) {
    super(`Workspace refresh step ${step} took longer than ${ms}ms`);
    this.name = "RefreshTimeout";
    this.step = step;
  }
}

/** Bounds one background read: it settles as the read does, or with a timeout. */
export type Deadline = <T>(work: Promise<T>, step: string) => Promise<T>;

/**
 * A deadline on real time. The background refresh must never wait on one read forever: a single
 * Git or forge call that never returns would otherwise stop every later sweep, and branches and
 * pull requests would silently stop updating. An abandoned read keeps running and its result is
 * dropped; the next sweep asks again.
 */
export function deadlineOf(ms: number): Deadline {
  return <T>(work: Promise<T>, step: string) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RefreshTimeout(step, ms)), ms);
      timer.unref();
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
}
