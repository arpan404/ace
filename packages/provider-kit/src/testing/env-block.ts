/** One variable whose `NAME=value\0` is exactly `bytes` long in UTF-8. */
export function variableOfBytes(name: string, bytes: number): Record<string, string> {
  return { [name]: "x".repeat(bytes - name.length - 2) };
}

/**
 * Variables filling exactly `budget` bytes of strings and pointers, as an exec counts them:
 * each variable is its string and an 8-byte pointer, and the block ends with one more pointer.
 * No string is longer than `chunk` plus the variable count.
 */
export function blockOfBytes(budget: number, chunk: number): Record<string, string> {
  const count = Math.ceil((budget - 8) / (chunk + 8));
  const strings = budget - 8 - 8 * count;
  const env: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const size = Math.floor(strings / count) + (index === 0 ? strings % count : 0);
    Object.assign(env, variableOfBytes(`V${index}`, size));
  }
  return env;
}
