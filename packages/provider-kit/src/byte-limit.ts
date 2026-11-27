import { supervisorBackend } from "./native-switches.ts";
import { nativeByteLimit } from "./native-streams.ts";

/** Pure configuration validation shared by framing and admission policies. */
export function byteLimit(value: number, name: string): number {
  if (supervisorBackend() === "native") return nativeByteLimit(value, name);
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Invalid ${name}`);
  return value;
}
