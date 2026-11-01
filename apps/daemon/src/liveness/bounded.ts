/** A step of a Stop that didn't answer within its bound (ADR 0052, "Stop and proof of life"). */
export class StopUnanswered extends Error {
  readonly step: string;
  constructor(step: string, ms: number) {
    super(`${step} did not answer within ${ms}ms`);
    this.step = step;
  }
}

/**
 * `work`, or StopUnanswered once `ms` pass on the injected timer first. The work itself keeps
 * running; the caller moves on to the next step of the stop.
 */
export function bounded<T>(
  setTimer: (callback: () => void, delay: number) => () => void,
  ms: number,
  step: string,
  work: Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cancel = setTimer(() => reject(new StopUnanswered(step, ms)), ms);
    work.then(
      (value) => {
        cancel();
        resolve(value);
      },
      (error: unknown) => {
        cancel();
        reject(error);
      },
    );
  });
}
