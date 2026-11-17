/**
 * Bounds for a child process environment ace builds from its own: an account's environment is
 * the person's whole shell environment plus its home selectors, which can run to hundreds of
 * variables. The bounds are what an OS can launch with, so they never refuse a real environment
 * and never admit an unbounded one. Linux caps one `NAME=value` string at 128 KiB
 * (MAX_ARG_STRLEN) and the whole block, with the arguments, at ARG_MAX: 2 MiB by default.
 * macOS (1 MiB) and Windows (32 Ki characters per variable) sit below both.
 */
export const ENV_NAME_LIMIT = 4096;
export const ENV_VALUE_LIMIT = 131_072;
export const ENV_BLOCK_LIMIT = 2_097_152;

/** The environment block's size as the OS counts it: every `NAME=value` and its terminator. */
export function environmentSize(env: Readonly<Record<string, string | undefined>>): number {
  let size = 0;
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) size += name.length + value.length + 2;
  return size;
}
