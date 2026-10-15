export type Frame = string | Uint8Array;

/** What holding one frame costs against the budget, in bytes. */
const frameBytes = (frame: Frame) =>
  typeof frame === "string" ? frame.length * 2 : frame.byteLength;

/**
 * Server frames waiting, in order, for the service schemas a frame among them needs. While a
 * load is out every later frame waits behind it, so nothing is read out of order.
 */
export class HeldFrames {
  #frames: Frame[] | undefined;
  #bytes = 0;
  #budget: number;
  constructor(budgetBytes: number) {
    this.#budget = budgetBytes;
  }
  get holding(): boolean {
    return this.#frames !== undefined;
  }
  /** Hold `frame` behind the others; false when that would go over budget. */
  push(frame: Frame): boolean {
    if (!this.#frames) return false;
    this.#bytes += frameBytes(frame);
    if (this.#bytes > this.#budget) return false;
    this.#frames.push(frame);
    return true;
  }
  /**
   * Start holding at `frame` until `load` settles. Once it loads, the held frames go to `replay`
   * in order; a failed load goes to `failed`. Neither runs if the frames were dropped meanwhile.
   */
  hold(
    frame: Frame,
    load: Promise<unknown>,
    replay: (frame: Frame) => void,
    failed: () => void,
  ): void {
    const frames: Frame[] = [frame];
    this.#frames = frames;
    this.#bytes = frameBytes(frame);
    load.then(
      () => {
        if (this.#frames !== frames) return;
        this.#frames = undefined;
        this.#bytes = 0;
        for (const next of frames) replay(next);
      },
      () => {
        if (this.#frames === frames) failed();
      },
    );
  }
  /** The socket ended: forget what was held. */
  clear(): void {
    this.#frames = undefined;
    this.#bytes = 0;
  }
}
