/** A computer-use failure whose message is written for the model. */
export class ComputerError extends Error {
  readonly code: string;
  /**
   * What the helper had done when a request was cancelled or overran: its reply, when it
   * replied after the cancel (an act lists the steps it finished).
   */
  readonly result: unknown;
  constructor(code: string, message: string, result?: unknown) {
    super(message);
    this.code = code;
    this.result = result;
  }
}
