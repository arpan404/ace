import type { KeptValueKey } from "@ace/native-host";
import { call } from "./host.ts";

/** One small value kept on this device between launches (`storage.value.*`), as JSON. */
export interface KeptValue {
  /**
   * The kept JSON, or undefined when nothing was kept. Rejects when the host can't read it or
   * what it holds isn't JSON: that is not "nothing kept", and must never be saved over.
   */
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

/** The kept value for `key`; callers parse what `load` answers with their own schema. */
export function keptValue(key: KeptValueKey): KeptValue {
  return {
    async load() {
      const text = await call("storage.value.load", { key });
      return text ? (JSON.parse(text) as unknown) : undefined;
    },
    async save(value) {
      await call("storage.value.save", { key }, JSON.stringify(value));
    },
  };
}
