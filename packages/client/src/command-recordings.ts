import type { CommandAllocation } from "./command-admission.ts";

/** Owns cancellation only until recording hands the allocation to admission. */
export class CommandRecordings {
  readonly #pending = new Set<() => void>();
  #closed = false;

  submit<T>(
    allocation: CommandAllocation,
    signal: AbortSignal | undefined,
    record: () => void | Promise<void>,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let recording = true;
      const cleanup = () => {
        this.#pending.delete(refuse);
        signal?.removeEventListener("abort", refuse);
      };
      const refuse = () => {
        if (!recording) return;
        recording = false;
        const error = allocation.refusal();
        allocation.releaseUnsent();
        cleanup();
        reject(error);
      };
      const proceed = () => {
        if (!recording) return;
        recording = false;
        cleanup();
        try {
          resolve(dispatch());
        } catch {
          const error = allocation.refusal();
          allocation.releaseUnsent();
          reject(error);
        }
      };
      this.#pending.add(refuse);
      signal?.addEventListener("abort", refuse, { once: true });
      if (this.#closed || signal?.aborted) return refuse();
      try {
        const recorded = record();
        if (recorded === undefined) proceed();
        else void Promise.resolve(recorded).then(proceed, refuse);
      } catch {
        refuse();
      }
    });
  }

  close(): void {
    this.#closed = true;
    for (const refuse of this.#pending) refuse();
  }
}
