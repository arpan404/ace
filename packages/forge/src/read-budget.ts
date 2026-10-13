import { ForgeError } from "./errors.ts";
const MAX_BYTES = 8_388_608;
/** Cumulative source bytes per snapshot, including cached pages. */
export class ReadBudget {
  #bytes = 0;
  /** Records bytes read; a snapshot that needs more than the budget fails. */
  add(bytes: number): void {
    if (!this.spend(bytes)) throw new ForgeError("limit");
  }
  /** Records bytes read; false once the snapshot is over budget and must stop reading. */
  spend(bytes: number): boolean {
    this.#bytes += bytes;
    return this.#bytes <= MAX_BYTES;
  }
}
