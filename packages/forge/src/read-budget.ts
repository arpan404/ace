import { ForgeError } from "./errors.ts";
/** Cumulative source bytes per snapshot, including cached pages. */
export class ReadBudget {
  #bytes = 0;
  add(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > 8_388_608) throw new ForgeError("limit");
  }
}
