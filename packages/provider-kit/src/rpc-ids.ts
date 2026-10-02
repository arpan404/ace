import { byteLimit } from "./output-budget.ts";

export type RpcId = string | number;
export function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Pure process-lifetime reservations. Generated ids need no historical entries. */
export class RpcIds {
  readonly #explicit = new Set<RpcId>();
  readonly #maxExplicit: number;
  #next = 1;
  constructor(maxExplicit: number) {
    this.#maxExplicit = byteLimit(maxExplicit, "maxExplicitIds");
  }
  reserve(id?: RpcId): RpcId {
    if (id !== undefined) {
      if (!isRpcId(id) || (typeof id === "string" && Buffer.byteLength(id) > 1024))
        throw new Error("Invalid request id");
      if (
        this.#explicit.has(id) ||
        (typeof id === "number" && Number.isInteger(id) && id > 0 && id < this.#next)
      )
        throw new Error("Request id already used");
      if (this.#explicit.size >= this.#maxExplicit) throw new Error("JSON-RPC explicit id limit");
      this.#explicit.add(id);
      return id;
    }
    while (this.#explicit.has(this.#next)) this.#next++;
    if (!Number.isSafeInteger(this.#next)) throw new Error("JSON-RPC id space exhausted");
    return this.#next++;
  }
}
