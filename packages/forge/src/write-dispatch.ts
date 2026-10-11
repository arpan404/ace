import { ForgeError } from "./errors.ts";
/** Per-write certainty. Only the transport handling the mutation can reject its dispatch. */
export class WriteDispatch {
  readonly #reserve: () => void;
  #failed = true;
  constructor(reserve: () => void = () => {}) {
    this.#reserve = reserve;
  }
  get definitelyFailed(): boolean {
    return this.#failed;
  }
  begin(): void {
    this.#reserve();
    // A crash from here onward must be reconciled unless the transport proves refusal.
    this.#failed = false;
  }
  reject(error: unknown): void {
    if (error instanceof ForgeError && error.dispatched === false)
      this.#failed = true;
  }
}
