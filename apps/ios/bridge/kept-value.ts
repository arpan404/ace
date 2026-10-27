import type { KeptValueKey } from "@ace/native-host";
import { call } from "./host.ts";

/** One small value kept on this device between launches (`storage.value.*`), as JSON. */
export interface KeptValue {
  /** The kept JSON, or undefined when nothing was kept or it can't be read. */
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
}

/** The kept value for `key`; callers parse what `load` answers with their own schema. */
export function keptValue(key: KeptValueKey): KeptValue {
  return {
    async load() {
      try {
        const text = await call("storage.value.load", { key });
        return text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        return undefined;
      }
    },
    async save(value) {
      await call("storage.value.save", { key }, JSON.stringify(value));
    },
  };
}
