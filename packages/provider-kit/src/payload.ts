import { z } from "zod";
import { isNativeRecord } from "./record.ts";

export const maxProviderPayloadBytes = 1024 * 1024;
const encoded = z.union([z.string(), z.instanceof(Uint8Array)]);

/** Own a bounded, immutable JSON value. No object-to-JSON admission path exists. */
export class ProviderPayload {
  #data: unknown;
  readonly bytes: number;
  constructor(source: string | Uint8Array) {
    const input = encoded.parse(source);
    // UTF-16 length is an O(1) lower bound on UTF-8 bytes. Check it before byteLength.
    if (input.length > maxProviderPayloadBytes)
      throw new RangeError("Provider payload exceeds byte limit");
    this.bytes = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
    if (this.bytes > maxProviderPayloadBytes)
      throw new RangeError("Provider payload exceeds byte limit");
    const text =
      typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    this.#data = JSON.parse(text);
    let nodes = 0;
    // Future native fields may be deeply nested. Bound work by bytes and node count,
    // and traverse iteratively so a valid envelope cannot exhaust the call stack.
    const pending: unknown[] = [this.#data];
    while (pending.length) {
      const value = pending.pop();
      if (++nodes > 32768) throw new RangeError("Provider payload exceeds structural limit");
      if (value === null || typeof value !== "object") continue;
      if (Array.isArray(value)) {
        for (const child of value) pending.push(child);
        Object.freeze(value);
      } else if (isNativeRecord(value)) {
        // A plain check, not a schema parse: this runs for every object node of every frame.
        for (const key in value) {
          if (Object.hasOwn(value, key)) pending.push(value[key]);
        }
        Object.freeze(value);
      } else throw new TypeError("Provider payload holds a non-JSON object");
    }
    Object.freeze(this);
  }
  get data(): unknown {
    return this.#data;
  }
  static is(value: unknown): value is ProviderPayload {
    return (
      value instanceof ProviderPayload &&
      Object.getPrototypeOf(value) === ProviderPayload.prototype &&
      #data in value
    );
  }
}
export const ProviderPayloadSchema = z.custom<ProviderPayload>(ProviderPayload.is);
