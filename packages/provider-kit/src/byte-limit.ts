/** Pure configuration validation shared by framing and admission policies. */
export function byteLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Invalid ${name}`);
  return value;
}
